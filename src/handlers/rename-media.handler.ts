/**
 * Rename Media Handler
 * Lambda handler for renaming user's media files
 * Updates filename in DynamoDB only - S3 keys remain unchanged
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  RenameMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  ErrorCode,
  RenameMediaData,
  RenameVideoData,
  RenameImageData,
  RenameAudioData,
  MediaItem,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { dynamoDBService } from '../services/dynamodb.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { sanitizeFilename } from '../utils/sanitize';
import { getAuthenticatedUserId } from '../utils/auth';

/**
 * Lambda handler for rename media requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'rename-media' });

  logger.info('Rename media request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    // Validate configuration on cold start
    validateConfig();

    // Extract authenticated userId from authorizer context
    const userId = getAuthenticatedUserId(event);
    logger.setContext({ userId });

    // Step 1: Parse request body
    logger.info('Step 1: Parsing rename request');
    const request = parseRequestBody(event);
    logger.info('Step 1: Request parsed', {
      mediaId: request.mediaId,
      newFilename: request.newFilename,
    });

    // Step 2: Validate request (with authenticated userId for authorization checks)
    logger.info('Step 2: Validating rename request', { mediaId: request.mediaId });
    validationService.validateRenameMediaRequest({ ...request, userId });
    logger.info('Step 2: Validation passed');

    // Sanitize new filename (validation already checked it's valid)
    const sanitizedFilename = sanitizeFilename(request.newFilename);

    // Step 3: Get existing record to verify ownership and get s3Key
    logger.info('Step 3: Fetching existing media record', { mediaId: request.mediaId });
    const mediaItem = await dynamoDBService.getMediaItem(userId, request.mediaId);
    if (!mediaItem) {
      logger.warn('Media not found for rename', { mediaId: request.mediaId, userId });
      throw new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Media not found');
    }
    logger.info('Step 3: Media record fetched', {
      mediaId: request.mediaId,
      mediaType: mediaItem.mediaType,
      currentFilename: mediaItem.filename,
    });

    // Step 4: Update filename in DynamoDB only (no S3 changes)
    logger.info('Step 4: Updating filename in DynamoDB', {
      mediaId: request.mediaId,
      newFilename: sanitizedFilename,
    });
    await dynamoDBService.updateMediaFilename(userId, request.mediaId, sanitizedFilename);
    logger.info('Step 4: Filename updated in DynamoDB');

    // Step 5: Build type-specific response data
    logger.info('Step 5: Building response with updated metadata', {
      mediaId: request.mediaId,
      mediaType: mediaItem.mediaType,
    });
    const responseData = await buildRenameResponseData(mediaItem, sanitizedFilename);

    // Build success response
    const response: RenameMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'File renamed successfully',
      data: responseData,
    };

    logger.info('Rename media request completed successfully', {
      mediaId: request.mediaId,
      newFilename: sanitizedFilename,
      userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Rename media request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse request body from event
 */
function parseRequestBody(event: APIGatewayProxyEventV2): { mediaId: string; newFilename: string } {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.mediaId || typeof body.mediaId !== 'string') {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "mediaId" field'
      );
    }

    if (!body.newFilename || typeof body.newFilename !== 'string') {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "newFilename" field'
      );
    }

    return {
      mediaId: body.mediaId,
      newFilename: body.newFilename,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Invalid JSON in request body'
    );
  }
}

/**
 * Build type-specific rename response data with rich metadata
 * - Videos: previewUrl + thumbnailUrl (from lowres bucket), duration, dimensions, sceneCount
 * - Images: previewUrl (from lowres bucket), dimensions, description
 * - Audio: url (from uploads bucket - original high-res), duration, segmentCount
 */
async function buildRenameResponseData(
  item: MediaItem,
  newFilename: string
): Promise<RenameMediaData> {
  switch (item.mediaType) {
    case 'video': {
      const videoData: RenameVideoData = {
        mediaId: item.mediaId,
        filename: newFilename,
        mediaType: 'video',
        mimeType: item.mimeType,
        size: item.sizeBytes,
        uploadedAt: item.createdAt,
        status: item.status,
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
      return videoData;
    }
    case 'image': {
      const imageData: RenameImageData = {
        mediaId: item.mediaId,
        filename: newFilename,
        mediaType: 'image',
        mimeType: item.mimeType,
        size: item.sizeBytes,
        uploadedAt: item.createdAt,
        status: item.status,
        // Preview URL from lowres bucket (no original URL exposed for images)
        previewUrl: item.previewS3Key
          ? await s3Service.generateLowresPresignedGetUrl(item.previewS3Key)
          : '',
        // Rich metadata from processing
        width: item.width ?? 0,
        height: item.height ?? 0,
        description: item.description ?? '',
      };
      return imageData;
    }
    case 'audio': {
      const audioData: RenameAudioData = {
        mediaId: item.mediaId,
        filename: newFilename,
        mediaType: 'audio',
        mimeType: item.mimeType,
        size: item.sizeBytes,
        uploadedAt: item.createdAt,
        status: item.status,
        // Original URL from uploads bucket (audio has no lowres version)
        url: await s3Service.generatePresignedGetUrl(item.s3Key),
        // Rich metadata from processing
        duration: item.duration ?? 0,
        segmentCount: item.segmentCount ?? 0,
      };
      return audioData;
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
  response: RenameMediaSuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'PATCH,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
