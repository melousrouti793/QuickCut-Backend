/**
 * Search Media Handler
 * Lambda handler for searching user's media files by partial filename
 * Queries DynamoDB for metadata, generates presigned URLs for S3 access
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  SearchMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  MediaFileInfo,
  MediaType,
  MediaTypeFilter,
  VideoFileInfo,
  ImageFileInfo,
  AudioFileInfo,
  MediaItem,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { dynamoDBService } from '../services/dynamodb.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { getAuthenticatedUserId } from '../utils/auth';

/**
 * Lambda handler for search media requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'search-media' });

  logger.info('Search media request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    // Validate configuration on cold start
    validateConfig();

    // Extract authenticated userId from authorizer context
    const userId = getAuthenticatedUserId(event);
    logger.setContext({ userId });

    // Step 1: Parse query parameters
    logger.info('Step 1: Parsing search parameters');
    const queryParams = parseQueryParameters(event);
    logger.info('Step 1: Search parameters parsed', {
      query: queryParams.query,
      mediaType: queryParams.mediaType,
      limit: queryParams.limit,
    });

    // Step 2: Validate query parameters
    logger.info('Step 2: Validating search parameters');
    validationService.validateSearchMediaQueryParams({
      query: queryParams.query,
      mediaType: queryParams.mediaType,
      limit: queryParams.limit,
      continuationToken: queryParams.continuationToken,
    });
    logger.info('Step 2: Validation passed');

    // Convert mediaType filter to DynamoDB format (singular form)
    const mediaType = convertMediaTypeFilter(queryParams.mediaType);
    const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : 50;

    // Step 3: Search media files from DynamoDB
    logger.info('Step 3: Searching DynamoDB', {
      userId,
      query: queryParams.query,
      mediaType,
      limit,
    });
    const items = await dynamoDBService.searchMediaByFilename(userId, queryParams.query, {
      mediaType,
      limit,
    });
    logger.info('Step 3: DynamoDB search completed', { matchCount: items.length });

    // Step 4: Generate presigned URLs and build type-specific responses
    logger.info('Step 4: Generating presigned URLs', { matchCount: items.length });
    const files: MediaFileInfo[] = await Promise.all(
      items.map((item) => buildMediaFileInfo(item))
    );
    logger.info('Step 4: Presigned URLs generated', { fileCount: files.length });

    // Step 5: Build success response
    logger.info('Step 5: Building response', { resultCount: files.length });
    const response: SearchMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Search completed successfully',
      data: {
        query: queryParams.query,
        mediaType: queryParams.mediaType as MediaTypeFilter | undefined,
        files,
        count: files.length,
        hasMore: files.length >= limit,
        nextToken: undefined, // Simplified pagination for search
      },
    };

    logger.info('Search media request completed successfully', {
      query: queryParams.query,
      matchCount: files.length,
      userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Search media request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse query parameters from event
 */
function parseQueryParameters(event: APIGatewayProxyEventV2): {
  query: string;
  mediaType?: string;
  limit?: string;
  continuationToken?: string;
} {
  const queryParams = event.queryStringParameters || {};

  if (!queryParams.query) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Query parameter "query" is required'
    );
  }

  return {
    query: queryParams.query,
    mediaType: queryParams.mediaType,
    limit: queryParams.limit,
    continuationToken: queryParams.continuationToken,
  };
}

/**
 * Convert media type filter from plural/aggregate form to singular DynamoDB form
 */
function convertMediaTypeFilter(filter?: string): MediaType | undefined {
  if (!filter) return undefined;

  const filterMap: Record<string, MediaType | undefined> = {
    video: 'video',
    videos: 'video',
    image: 'image',
    images: 'image',
    audio: 'audio',
    audios: 'audio',
  };

  return filterMap[filter.toLowerCase()];
}

/**
 * Build type-specific MediaFileInfo from DynamoDB item with rich metadata
 * - Videos: previewUrl + thumbnailUrl (from lowres bucket), duration, dimensions, sceneCount
 * - Images: previewUrl (from lowres bucket), dimensions, description
 * - Audio: url (from uploads bucket - original high-res), duration, segmentCount
 */
async function buildMediaFileInfo(item: MediaItem): Promise<MediaFileInfo> {
  const baseInfo = {
    mediaId: item.mediaId,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.sizeBytes,
    uploadedAt: item.createdAt,
    status: item.status,
  };

  switch (item.mediaType) {
    case 'video': {
      const videoInfo: VideoFileInfo = {
        ...baseInfo,
        mediaType: 'video',
        // Preview and thumbnail URLs from lowres bucket
        previewUrl: item.previewS3Key
          ? await s3Service.generateLowresPresignedGetUrl(item.previewS3Key)
          : '',
        thumbnailUrl: item.thumbnailS3Key
          ? await s3Service.generateLowresPresignedGetUrl(item.thumbnailS3Key)
          : null,
        // Rich metadata from processing
        duration: item.duration ?? 0,
        width: item.width ?? 0,
        height: item.height ?? 0,
        sceneCount: item.sceneCount ?? 0,
      };
      return videoInfo;
    }
    case 'image': {
      const imageInfo: ImageFileInfo = {
        ...baseInfo,
        mediaType: 'image',
        // Preview URL from lowres bucket (no original URL exposed for images)
        previewUrl: item.previewS3Key
          ? await s3Service.generateLowresPresignedGetUrl(item.previewS3Key)
          : '',
        // Rich metadata from processing
        width: item.width ?? 0,
        height: item.height ?? 0,
        description: item.description ?? '',
      };
      return imageInfo;
    }
    case 'audio': {
      const audioInfo: AudioFileInfo = {
        ...baseInfo,
        mediaType: 'audio',
        // Original URL from uploads bucket (audio has no lowres version)
        url: await s3Service.generatePresignedGetUrl(item.s3Key),
        // Rich metadata from processing
        duration: item.duration ?? 0,
        segmentCount: item.segmentCount ?? 0,
      };
      return audioInfo;
    }
  }
}

/**
 * Handle errors and return appropriate response
 */
function handleError(
  error: unknown,
  requestId: string
): APIGatewayProxyResultV2 {
  // Handle known application errors
  if (error instanceof AppError) {
    const errorResponse: ErrorResponse = {
      statusCode: error.statusCode,
      errorCode: error.errorCode,
      message: error.message,
      details: error.details,
      requestId,
    };

    return buildApiResponse(errorResponse);
  }

  // Handle unexpected errors
  logger.error('Unexpected error occurred', error);

  const errorResponse: ErrorResponse = {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
    requestId,
  };

  return buildApiResponse(errorResponse);
}

/**
 * Build API Gateway response with proper headers
 */
function buildApiResponse(
  response: SearchMediaSuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
