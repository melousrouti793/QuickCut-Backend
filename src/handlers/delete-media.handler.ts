/**
 * Delete Media Handler
 * Lambda handler for deleting user's media files
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  DeleteMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
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
      fileCount: request.fileKeys.length,
    });

    // Delete media files from S3
    const results = await s3Service.deleteMediaFiles(request.fileKeys);

    // Separate successful and failed deletions
    const deleted = results.filter((r) => r.success).map((r) => r.fileKey);
    const failed = results.filter((r) => !r.success);

    // Build success response
    const response: DeleteMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Files deleted successfully',
      data: {
        deleted,
        failed,
        totalRequested: request.fileKeys.length,
        successCount: deleted.length,
        failureCount: failed.length,
      },
    };

    logger.info('Delete media request completed', {
      totalRequested: request.fileKeys.length,
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
function parseRequestBody(event: APIGatewayProxyEventV2): { fileKeys: string[] } {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.fileKeys || !Array.isArray(body.fileKeys)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "fileKeys" array'
      );
    }

    return {
      fileKeys: body.fileKeys,
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
