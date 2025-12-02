/**
 * Playback Handler
 * Lambda handler for fetching video chunk URLs and audio playback URLs
 * POST /playback - Returns presigned URLs for video chunks and audio files
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  PlaybackSuccessResponse,
  ErrorResponse,
  HttpStatus,
  PlaybackItem,
  PlaybackVideoItem,
  PlaybackAudioItem,
  PlaybackChunk,
  MediaItem,
} from '../types';
import { AppError } from '../errors/AppError';
import { dynamoDBService } from '../services/dynamodb.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { getAuthenticatedUserId } from '../utils/auth';

interface PlaybackRequestItem {
  mediaId: string;
  chunks?: number[];
}

interface PlaybackRequest {
  items: PlaybackRequestItem[];
}

/**
 * Lambda handler for playback requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  logger.setContext({ requestId, action: 'playback' });

  logger.info('Playback request received', {
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

    const { items: requestItems } = body;
    const requestedCount = requestItems.length;

    logger.info('Playback request parsed', { requestedCount });

    // Extract unique mediaIds from request
    const mediaIds = [...new Set(requestItems.map((item) => item.mediaId))];

    // Batch fetch media items from DynamoDB
    const mediaItems = await dynamoDBService.batchGetMediaByIds(userId, mediaIds);

    // Create a map for quick lookup
    const itemMap = new Map<string, MediaItem>();
    for (const item of mediaItems) {
      itemMap.set(item.mediaId, item);
    }

    // Build playback responses
    const playbackItems: PlaybackItem[] = [];

    for (const requestItem of requestItems) {
      const mediaItem = itemMap.get(requestItem.mediaId);
      if (!mediaItem) {
        // Media not found or not ready - skip silently
        continue;
      }

      // Only process video and audio
      if (mediaItem.mediaType === 'image') {
        logger.warn('Skipping image in playback request', { mediaId: mediaItem.mediaId });
        continue;
      }

      const playbackItem = await buildPlaybackItem(mediaItem, requestItem.chunks);
      if (playbackItem) {
        playbackItems.push(playbackItem);
      }
    }

    const response: PlaybackSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Playback URLs generated successfully',
      data: {
        items: playbackItems,
        count: playbackItems.length,
        requestedCount,
      },
    };

    logger.info('Playback request completed successfully', {
      requestedCount,
      returnedCount: playbackItems.length,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Playback request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse request body from event
 */
function parseRequestBody(event: APIGatewayProxyEventV2): PlaybackRequest {
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
 * Validate the playback request
 */
function validateRequest(body: PlaybackRequest): void {
  if (!body.items || !Array.isArray(body.items)) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'items array is required'
    );
  }

  if (body.items.length === 0) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'items array cannot be empty'
    );
  }

  if (body.items.length > 50) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'items array cannot exceed 50 items'
    );
  }

  // Validate each item
  for (const item of body.items) {
    if (!item.mediaId || typeof item.mediaId !== 'string') {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Each item must have a mediaId string'
      );
    }

    if (item.chunks !== undefined) {
      if (!Array.isArray(item.chunks)) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'INVALID_REQUEST' as any,
          'chunks must be an array of numbers'
        );
      }

      for (const chunk of item.chunks) {
        if (typeof chunk !== 'number' || chunk < 0 || !Number.isInteger(chunk)) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'INVALID_REQUEST' as any,
            'chunks must be non-negative integers'
          );
        }
      }
    }
  }
}

/**
 * Build PlaybackItem from media item
 */
async function buildPlaybackItem(
  mediaItem: MediaItem,
  chunks?: number[]
): Promise<PlaybackItem | null> {
  if (mediaItem.mediaType === 'video') {
    return buildVideoPlaybackItem(mediaItem, chunks);
  } else if (mediaItem.mediaType === 'audio') {
    return buildAudioPlaybackItem(mediaItem);
  }
  return null;
}

/**
 * Build PlaybackVideoItem with chunk URLs
 */
async function buildVideoPlaybackItem(
  mediaItem: MediaItem,
  chunks?: number[]
): Promise<PlaybackVideoItem | null> {
  if (!chunks || chunks.length === 0) {
    logger.warn('Video playback request missing chunks array', { mediaId: mediaItem.mediaId });
    return null;
  }

  if (!mediaItem.chunksS3Prefix) {
    logger.error('Missing chunksS3Prefix for ready video', { mediaId: mediaItem.mediaId });
    return null;
  }

  const chunkUrls: PlaybackChunk[] = [];

  for (const chunkIndex of chunks) {
    // Format chunk filename: chunk_000.mp4, chunk_001.mp4, etc.
    const chunkFilename = `chunk_${chunkIndex.toString().padStart(3, '0')}.mp4`;
    const chunkS3Key = `${mediaItem.chunksS3Prefix}${chunkFilename}`;

    try {
      const url = await s3Service.generateLowresPresignedGetUrl(chunkS3Key);
      chunkUrls.push({
        index: chunkIndex,
        url,
      });
    } catch (error) {
      logger.error('Failed to generate chunk URL', error, {
        mediaId: mediaItem.mediaId,
        chunkIndex,
        chunkS3Key,
      });
      // Continue with other chunks even if one fails
    }
  }

  if (chunkUrls.length === 0) {
    return null;
  }

  return {
    mediaId: mediaItem.mediaId,
    mediaType: 'video',
    chunks: chunkUrls,
  };
}

/**
 * Build PlaybackAudioItem with playback URL
 */
async function buildAudioPlaybackItem(
  mediaItem: MediaItem
): Promise<PlaybackAudioItem | null> {
  // For audio, use previewS3Key for playback
  if (!mediaItem.previewS3Key) {
    logger.error('Missing previewS3Key for ready audio', { mediaId: mediaItem.mediaId });
    return null;
  }

  try {
    const url = await s3Service.generateLowresPresignedGetUrl(mediaItem.previewS3Key);
    return {
      mediaId: mediaItem.mediaId,
      mediaType: 'audio',
      url,
    };
  } catch (error) {
    logger.error('Failed to generate audio playback URL', error, { mediaId: mediaItem.mediaId });
    return null;
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
  response: PlaybackSuccessResponse | ErrorResponse
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
