/**
 * List Media Handler
 * Lambda handler for listing user's media files
 * Queries DynamoDB for metadata, generates presigned URLs for S3 access
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  ListMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  MediaFileInfo,
  MediaType,
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
 * Lambda handler for list media requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'list-media' });

  logger.info('List media request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    // Validate configuration on cold start
    validateConfig();

    // Extract authenticated userId from authorizer context
    const userId = getAuthenticatedUserId(event);
    logger.setContext({ userId });

    // Parse query parameters
    const queryParams = parseQueryParameters(event);

    // Validate query parameters
    validationService.validateListMediaQueryParams({
      mediaType: queryParams.mediaType,
      limit: queryParams.limit,
      continuationToken: queryParams.continuationToken,
    });

    // Convert mediaType filter to DynamoDB format (singular form)
    const mediaType = convertMediaTypeFilter(queryParams.mediaType);

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

    // Query DynamoDB for user's media
    const result = await dynamoDBService.getMediaByUser(userId, {
      mediaType,
      status: 'ready',
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : 50,
      exclusiveStartKey,
    });

    // Generate presigned URLs and build type-specific responses
    const files: MediaFileInfo[] = await Promise.all(
      result.items.map((item) => buildMediaFileInfo(item))
    );

    // Encode next token if more results available
    let nextToken: string | undefined;
    if (result.lastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString('base64');
    }

    // Build success response
    const response: ListMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Media files retrieved successfully',
      data: {
        files,
        count: files.length,
        hasMore: !!result.lastEvaluatedKey,
        nextToken,
      },
    };

    logger.info('List media request completed successfully', {
      fileCount: files.length,
      hasMore: !!result.lastEvaluatedKey,
      userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('List media request failed', error);
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
 * Input: 'videos' | 'images' | 'audios' | 'visual' | undefined
 * Output: 'video' | 'image' | 'audio' | undefined
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
    // 'visual' returns undefined to get both videos and images (handled differently)
  };

  return filterMap[filter.toLowerCase()];
}

/**
 * Build type-specific MediaFileInfo from DynamoDB item
 * - Videos: previewUrl + thumbnailUrl
 * - Images: url (original) + previewUrl
 * - Audio: url (original)
 */
async function buildMediaFileInfo(item: MediaItem): Promise<MediaFileInfo> {
  const baseInfo = {
    mediaId: item.mediaId,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.sizeBytes,
    uploadedAt: item.createdAt,
  };

  switch (item.mediaType) {
    case 'video': {
      const videoInfo: VideoFileInfo = {
        ...baseInfo,
        mediaType: 'video',
        previewUrl: item.previewS3Key
          ? await s3Service.generatePresignedGetUrl(item.previewS3Key)
          : '',
        thumbnailUrl: item.thumbnailS3Key
          ? await s3Service.generatePresignedGetUrl(item.thumbnailS3Key)
          : '',
      };
      return videoInfo;
    }
    case 'image': {
      const imageInfo: ImageFileInfo = {
        ...baseInfo,
        mediaType: 'image',
        url: await s3Service.generatePresignedGetUrl(item.s3Key),
        previewUrl: item.previewS3Key
          ? await s3Service.generatePresignedGetUrl(item.previewS3Key)
          : '',
      };
      return imageInfo;
    }
    case 'audio': {
      const audioInfo: AudioFileInfo = {
        ...baseInfo,
        mediaType: 'audio',
        url: await s3Service.generatePresignedGetUrl(item.s3Key),
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
  response: ListMediaSuccessResponse | ErrorResponse
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
