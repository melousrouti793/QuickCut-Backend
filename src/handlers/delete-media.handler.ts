/**
 * Delete Media Handler
 * Lambda handler for deleting user's media files
 * Deletes from both S3 and DynamoDB by mediaId
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  DeleteMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  DeleteResult,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
import { dynamoDBService } from '../services/dynamodb.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { getAuthenticatedUserId } from '../utils/auth';

/**
 * Lambda handler for delete media requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'delete-media' });

  logger.info('Delete media request received', {
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
    logger.info('Step 1: Parsing delete request');
    const request = parseRequestBody(event);
    logger.info('Step 1: Request parsed', { mediaIdCount: request.mediaIds.length });

    // Step 2: Validate request (with authenticated userId for authorization checks)
    logger.info('Step 2: Validating delete request', { mediaIdCount: request.mediaIds.length });
    validationService.validateDeleteMediaRequest({ ...request, userId });
    logger.info('Step 2: Validation passed');

    // Step 3: Delete each media item (from S3 and DynamoDB)
    logger.info('Step 3: Deleting media files', {
      userId,
      mediaCount: request.mediaIds.length,
    });

    const results: DeleteResult[] = await Promise.all(
      request.mediaIds.map(async (mediaId) => {
        try {
          // Get the media item from DynamoDB to find S3 keys
          logger.debug('Deleting media item', { mediaId, step: 'start' });
          const mediaItem = await dynamoDBService.getMediaItem(userId, mediaId);

          if (!mediaItem) {
            logger.debug('Media item not found', { mediaId });
            return {
              mediaId,
              success: false,
              error: 'Media not found',
            };
          }

          logger.debug('Fetched media record from DynamoDB', {
            mediaId,
            mediaType: mediaItem.mediaType,
            hasPreview: !!mediaItem.previewS3Key,
            hasThumbnail: !!mediaItem.thumbnailS3Key,
          });

          // Delete from S3 uploads bucket (main/original file)
          logger.debug('Deleting from uploads bucket', { mediaId, s3Key: mediaItem.s3Key });
          await s3Service.deleteObject(mediaItem.s3Key);
          logger.debug('Deleted from uploads bucket', { mediaId, s3Key: mediaItem.s3Key });

          // Delete preview from lowres bucket if exists (videos and images)
          if (mediaItem.previewS3Key) {
            try {
              logger.debug('Deleting preview from lowres bucket', { mediaId, previewS3Key: mediaItem.previewS3Key });
              await s3Service.deleteLowresObject(mediaItem.previewS3Key);
              logger.debug('Deleted preview from lowres bucket', { mediaId, previewS3Key: mediaItem.previewS3Key });
            } catch (previewError) {
              // Log but don't fail if preview deletion fails
              logger.warn('Failed to delete preview from lowres bucket', {
                mediaId,
                previewS3Key: mediaItem.previewS3Key,
                error: previewError instanceof Error ? previewError.message : String(previewError),
              });
            }
          }

          // Delete thumbnail from lowres bucket if exists (videos only)
          if (mediaItem.thumbnailS3Key) {
            try {
              logger.debug('Deleting thumbnail from lowres bucket', { mediaId, thumbnailS3Key: mediaItem.thumbnailS3Key });
              await s3Service.deleteLowresObject(mediaItem.thumbnailS3Key);
              logger.debug('Deleted thumbnail from lowres bucket', { mediaId, thumbnailS3Key: mediaItem.thumbnailS3Key });
            } catch (thumbnailError) {
              // Log but don't fail if thumbnail deletion fails
              logger.warn('Failed to delete thumbnail from lowres bucket', {
                mediaId,
                thumbnailS3Key: mediaItem.thumbnailS3Key,
                error: thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError),
              });
            }
          }

          // Delete from DynamoDB
          logger.debug('Deleting DynamoDB record', { mediaId });
          await dynamoDBService.deleteMediaRecord(userId, mediaId);
          logger.debug('Deleted DynamoDB record', { mediaId });

          logger.info('Deleted media item', { mediaId, step: 'complete', mediaType: mediaItem.mediaType });
          return {
            mediaId,
            success: true,
          };
        } catch (error) {
          logger.error('Failed to delete media', error, { mediaId, step: 'failed' });
          return {
            mediaId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      })
    );

    // Separate successful and failed deletions
    const deleted = results.filter((r) => r.success).map((r) => r.mediaId);
    const failed = results.filter((r) => !r.success);

    logger.info('Step 3: Delete operations completed', {
      successCount: deleted.length,
      failureCount: failed.length,
    });

    // Step 4: Build success response
    logger.info('Step 4: Building response', {
      successCount: deleted.length,
      failureCount: failed.length,
    });
    const response: DeleteMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Files deleted successfully',
      data: {
        deleted,
        failed,
        totalRequested: request.mediaIds.length,
        successCount: deleted.length,
        failureCount: failed.length,
      },
    };

    logger.info('Delete media request completed', {
      totalRequested: request.mediaIds.length,
      successCount: deleted.length,
      failureCount: failed.length,
      userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Delete media request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse request body from event
 */
function parseRequestBody(event: APIGatewayProxyEventV2): { mediaIds: string[] } {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.mediaIds || !Array.isArray(body.mediaIds)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "mediaIds" array'
      );
    }

    return {
      mediaIds: body.mediaIds,
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
  response: DeleteMediaSuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'DELETE,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
