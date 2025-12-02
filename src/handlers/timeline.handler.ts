/**
 * Timeline Handler
 * Lambda handler for fetching specific media items with rich metadata
 * POST /timeline - Returns media optimized for timeline editing
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  TimelineSuccessResponse,
  ErrorResponse,
  HttpStatus,
  TimelineMediaFile,
  TimelineAudioFile,
  TimelineImageFile,
  TimelineVideoFile,
  ThumbnailSpriteData,
  MediaItem,
} from '../types';
import { AppError } from '../errors/AppError';
import { dynamoDBService } from '../services/dynamodb.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { getAuthenticatedUserId } from '../utils/auth';

interface TimelineRequest {
  mediaIds: string[];
}

/**
 * Lambda handler for timeline requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  logger.setContext({ requestId, action: 'timeline' });

  logger.info('Timeline request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    validateConfig();

    const userId = getAuthenticatedUserId(event);
    logger.setContext({ userId });

    // Parse and validate request body
    const body = parseRequestBody(event);
    validateRequest(body);

    const { mediaIds } = body;
    const requestedCount = mediaIds.length;

    logger.info('Timeline request parsed', { requestedCount });

    // Batch fetch media items from DynamoDB
    const items = await dynamoDBService.batchGetMediaByIds(userId, mediaIds);

    // Create a map for preserving order
    const itemMap = new Map<string, MediaItem>();
    for (const item of items) {
      itemMap.set(item.mediaId, item);
    }

    // Build timeline responses preserving original order
    const files: TimelineMediaFile[] = [];
    for (const mediaId of mediaIds) {
      const item = itemMap.get(mediaId);
      if (item) {
        const fileInfo = await buildTimelineFileInfo(item);
        files.push(fileInfo);
      }
    }

    const response: TimelineSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Timeline media retrieved successfully',
      data: {
        files,
        count: files.length,
        requestedCount,
      },
    };

    logger.info('Timeline request completed successfully', {
      requestedCount,
      returnedCount: files.length,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Timeline request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse request body from event
 */
function parseRequestBody(event: APIGatewayProxyEventV2): TimelineRequest {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    return JSON.parse(event.body);
  } catch {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Invalid JSON in request body'
    );
  }
}

/**
 * Validate the timeline request
 */
function validateRequest(body: TimelineRequest): void {
  if (!body.mediaIds || !Array.isArray(body.mediaIds)) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'mediaIds array is required'
    );
  }

  if (body.mediaIds.length === 0) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'mediaIds array cannot be empty'
    );
  }

  if (body.mediaIds.length > 100) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'mediaIds array cannot exceed 100 items'
    );
  }
}

/**
 * Build rich TimelineMediaFile from DynamoDB item
 */
async function buildTimelineFileInfo(item: MediaItem): Promise<TimelineMediaFile> {
  switch (item.mediaType) {
    case 'audio': {
      let waveformUrl: string | null = null;
      if (item.waveformS3Key) {
        try {
          waveformUrl = await s3Service.generateLowresPresignedGetUrl(item.waveformS3Key);
        } catch (error) {
          logger.error('Failed to generate waveform URL', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing waveformS3Key for ready audio', { mediaId: item.mediaId });
      }

      const audioInfo: TimelineAudioFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'audio',
        waveformUrl,
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

      let timelineThumbUrl: string | null = null;
      if (item.timelineThumbS3Key) {
        try {
          timelineThumbUrl = await s3Service.generateLowresPresignedGetUrl(item.timelineThumbS3Key);
        } catch (error) {
          logger.error('Failed to generate timeline thumb URL', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing timelineThumbS3Key for ready image', { mediaId: item.mediaId });
      }

      const width = item.width ?? 0;
      const height = item.height ?? 0;
      const aspectRatio = height > 0 ? width / height : 0;

      const imageInfo: TimelineImageFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'image',
        previewUrl,
        width,
        height,
        fileSize: item.sizeBytes,
        aspectRatio,
        timelineThumbUrl,
      };
      return imageInfo;
    }

    case 'video': {
      let thumbnailUrl: string | null = null;
      if (item.thumbnailS3Key) {
        try {
          thumbnailUrl = await s3Service.generateLowresPresignedGetUrl(item.thumbnailS3Key);
        } catch (error) {
          logger.error('Failed to generate thumbnail URL', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing thumbnailS3Key for ready video', { mediaId: item.mediaId });
      }

      // Build scrubThumbs
      let scrubThumbs: ThumbnailSpriteData | null = null;
      if (item.scrubThumbs) {
        try {
          const url = await s3Service.generateLowresPresignedGetUrl(item.scrubThumbs.s3Key);
          const vttUrl = await s3Service.generateLowresPresignedGetUrl(item.scrubThumbs.vttS3Key);
          scrubThumbs = {
            url,
            vttUrl,
            width: item.scrubThumbs.width,
            height: item.scrubThumbs.height,
            interval: item.scrubThumbs.interval,
            count: item.scrubThumbs.count,
          };
        } catch (error) {
          logger.error('Failed to generate scrubThumbs URLs', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing scrubThumbs for ready video', { mediaId: item.mediaId });
      }

      // Build timelineThumbs
      let timelineThumbs: ThumbnailSpriteData | null = null;
      if (item.timelineThumbs) {
        try {
          const url = await s3Service.generateLowresPresignedGetUrl(item.timelineThumbs.s3Key);
          const vttUrl = await s3Service.generateLowresPresignedGetUrl(item.timelineThumbs.vttS3Key);
          timelineThumbs = {
            url,
            vttUrl,
            width: item.timelineThumbs.width,
            height: item.timelineThumbs.height,
            interval: item.timelineThumbs.interval,
            count: item.timelineThumbs.count,
          };
        } catch (error) {
          logger.error('Failed to generate timelineThumbs URLs', error, { mediaId: item.mediaId });
        }
      } else {
        logger.error('Missing timelineThumbs for ready video', { mediaId: item.mediaId });
      }

      const width = item.width ?? 0;
      const height = item.height ?? 0;
      const aspectRatio = height > 0 ? width / height : 0;

      const videoInfo: TimelineVideoFile = {
        mediaId: item.mediaId,
        filename: item.filename,
        mediaType: 'video',
        thumbnailUrl,
        width,
        height,
        fileSize: item.sizeBytes,
        duration: item.duration ?? 0,
        aspectRatio,
        scrubThumbs,
        timelineThumbs,
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
  response: TimelineSuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
