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

    // Parse request body
    const request = parseRequestBody(event);

    // Validate request (with authenticated userId for authorization checks)
    validationService.validateDeleteMediaRequest({ ...request, userId });

    logger.info('Deleting media files', {
      userId,
      mediaCount: request.mediaIds.length,
    });

    // Delete each media item (from S3 and DynamoDB)
    const results: DeleteResult[] = await Promise.all(
      request.mediaIds.map(async (mediaId) => {
        try {
          // Get the media item from DynamoDB to find S3 keys
          const mediaItem = await dynamoDBService.getMediaItem(userId, mediaId);

          if (!mediaItem) {
            return {
              mediaId,
              success: false,
              error: 'Media not found',
            };
          }

          // Delete from S3 (main file)
          await s3Service.deleteObject(mediaItem.s3Key);

          // Delete preview if exists
          if (mediaItem.previewS3Key) {
            try {
              await s3Service.deleteObject(mediaItem.previewS3Key);
            } catch (previewError) {
              // Log but don't fail if preview deletion fails
              logger.warn('Failed to delete preview', {
                mediaId,
                previewS3Key: mediaItem.previewS3Key,
                error: previewError instanceof Error ? previewError.message : String(previewError),
              });
            }
          }

          // Delete thumbnail if exists
          if (mediaItem.thumbnailS3Key) {
            try {
              await s3Service.deleteObject(mediaItem.thumbnailS3Key);
            } catch (thumbnailError) {
              // Log but don't fail if thumbnail deletion fails
              logger.warn('Failed to delete thumbnail', {
                mediaId,
                thumbnailS3Key: mediaItem.thumbnailS3Key,
                error: thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError),
              });
            }
          }

          // Delete from DynamoDB
          await dynamoDBService.deleteMediaRecord(userId, mediaId);

          return {
            mediaId,
            success: true,
          };
        } catch (error) {
          logger.error('Failed to delete media', error, { mediaId });
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

    // Build success response
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
