/**
 * Library Handler
 * Lambda handler for listing user's media files with simplified response
 * GET /library - Returns media optimized for library/grid view
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  ListLibrarySuccessResponse,
  ErrorResponse,
  HttpStatus,
  LibraryMediaFile,
  LibraryAudioFile,
  LibraryImageFile,
  LibraryVideoFile,
  MediaType,
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
 * Lambda handler for library requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  logger.setContext({ requestId, action: 'list-library' });

  logger.info('Library request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    validateConfig();

    const userId = getAuthenticatedUserId(event);
    logger.setContext({ userId });

    // Parse query parameters
    const queryParams = parseQueryParameters(event);
    logger.info('Query parameters parsed', {
      mediaType: queryParams.mediaType,
      limit: queryParams.limit,
      hasToken: !!queryParams.continuationToken,
    });

    // Validate query parameters
    validationService.validateListMediaQueryParams({
      mediaType: queryParams.mediaType,
      limit: queryParams.limit,
      continuationToken: queryParams.continuationToken,
    });

    // Convert mediaType filter to DynamoDB format
    const mediaTypeFilter = convertMediaTypeFilter(queryParams.mediaType);

    // Decode continuation token if provided
    let exclusiveStartKey: Record<string, any> | undefined;
    if (queryParams.continuationToken) {
      try {
        exclusiveStartKey = JSON.parse(
          Buffer.from(queryParams.continuationToken, 'base64').toString('utf-8')
        );
      } catch {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'INVALID_REQUEST' as any,
          'Invalid continuation token'
        );
      }
    }

    const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : 50;

    let allItems: MediaItem[];
    let lastEvaluatedKey: Record<string, any> | undefined;

    // Handle "visual" filter with two separate queries (video + image)
    if (mediaTypeFilter === 'visual') {
      // Query videos and images separately, then merge
      const halfLimit = Math.ceil(limit / 2);

      const [videoResult, imageResult] = await Promise.all([
        dynamoDBService.getMediaByUser(userId, {
          mediaType: 'video',
          status: 'ready',
          limit: halfLimit,
          exclusiveStartKey: exclusiveStartKey?.type === 'video' ? exclusiveStartKey.key : undefined,
        }),
        dynamoDBService.getMediaByUser(userId, {
          mediaType: 'image',
          status: 'ready',
          limit: halfLimit,
          exclusiveStartKey: exclusiveStartKey?.type === 'image' ? exclusiveStartKey.key : undefined,
        }),
      ]);

      // Merge and sort by createdAt descending
      allItems = [...videoResult.items, ...imageResult.items]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);

      // For visual queries, we have more if either query has more
      if (videoResult.lastEvaluatedKey || imageResult.lastEvaluatedKey) {
        lastEvaluatedKey = {
          visual: true,
          video: videoResult.lastEvaluatedKey,
          image: imageResult.lastEvaluatedKey,
        };
      }
    } else {
      // Single media type query (mediaTypeFilter is MediaType | undefined here, not 'visual')
      const result = await dynamoDBService.getMediaByUser(userId, {
        mediaType: mediaTypeFilter as MediaType | undefined,
        status: 'ready',
        limit,
        exclusiveStartKey,
      });
      allItems = result.items;
      lastEvaluatedKey = result.lastEvaluatedKey;
    }

    // Build simplified library responses
    const files: LibraryMediaFile[] = await Promise.all(
      allItems.map((item) => buildLibraryFileInfo(item))
    );

    // Encode next token if more results available
    let nextToken: string | undefined;
    if (lastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64');
    }

    const response: ListLibrarySuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Library files retrieved successfully',
      data: {
        files,
        count: files.length,
        hasMore: !!lastEvaluatedKey,
        nextToken,
      },
    };

    logger.info('Library request completed successfully', {
      fileCount: files.length,
      hasMore: !!lastEvaluatedKey,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Library request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse query parameters from event
 */
function parseQueryParameters(event: APIGatewayProxyEventV2): {
  mediaType?: string;
  limit?: string;
  continuationToken?: string;
} {
  const queryParams = event.queryStringParameters || {};
  return {
    mediaType: queryParams.mediaType,
    limit: queryParams.limit,
    continuationToken: queryParams.continuationToken,
  };
}

/**
 * Convert media type filter from plural/aggregate form to singular DynamoDB form
 * Returns 'visual' for visual filter (images + videos), which requires special handling
 */
function convertMediaTypeFilter(filter?: string): MediaType | 'visual' | undefined {
  if (!filter) return undefined;

  const filterMap: Record<string, MediaType | 'visual' | undefined> = {
    video: 'video',
    videos: 'video',
    image: 'image',
    images: 'image',
    audio: 'audio',
    audios: 'audio',
    visual: 'visual',
  };

  return filterMap[filter.toLowerCase()];
}

/**
 * Build simplified LibraryMediaFile from DynamoDB item
 */
async function buildLibraryFileInfo(item: MediaItem): Promise<LibraryMediaFile> {
  switch (item.mediaType) {
    case 'audio': {
      const audioInfo: LibraryAudioFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'audio',
        fileSize: item.sizeBytes,
        duration: item.duration ?? 0,
      };
      return audioInfo;
    }

    case 'image': {
      let previewUrl: string | null = null;
      if (item.previewS3Key) {
        try {
          previewUrl = await s3Service.generateLowresPresignedGetUrl(item.previewS3Key);
        } catch (error) {
          logger.error('Failed to generate preview URL for image', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing previewS3Key for ready image', { mediaId: item.mediaId });
      }

      const width = item.width ?? 0;
      const height = item.height ?? 0;
      const aspectRatio = height > 0 ? width / height : 0;

      const imageInfo: LibraryImageFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'image',
        previewUrl,
        width,
        height,
        fileSize: item.sizeBytes,
        aspectRatio,
      };
      return imageInfo;
    }

    case 'video': {
      let thumbnailUrl: string | null = null;
      if (item.thumbnailS3Key) {
        try {
          thumbnailUrl = await s3Service.generateLowresPresignedGetUrl(item.thumbnailS3Key);
        } catch (error) {
          logger.error('Failed to generate thumbnail URL for video', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing thumbnailS3Key for ready video', { mediaId: item.mediaId });
      }

      const width = item.width ?? 0;
      const height = item.height ?? 0;
      const aspectRatio = height > 0 ? width / height : 0;

      const videoInfo: LibraryVideoFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'video',
        thumbnailUrl,
        width,
        height,
        fileSize: item.sizeBytes,
        duration: item.duration ?? 0,
        aspectRatio,
      };
      return videoInfo;
    }
  }
}

/**
 * Handle errors and return appropriate response
 */
function handleError(error: unknown, requestId: string): APIGatewayProxyResultV2 {
  if (error instanceof AppError) {
    const errorResponse: ErrorResponse = {
      statusCode: error.statusCode,
      errorCode: error.errorCode,
      message: error.message,
      requestId,
    };
    return buildApiResponse(errorResponse);
  }

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
  response: ListLibrarySuccessResponse | ErrorResponse
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
