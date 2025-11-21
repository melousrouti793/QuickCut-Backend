/**
 * Rename Media Handler
 * Lambda handler for renaming user's media files
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  RenameMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  ErrorCode,
} from '../types';
import { AppError, S3ServiceError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
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

    // Parse request body
    const request = parseRequestBody(event);

    // Validate request (with authenticated userId for authorization checks)
    validationService.validateRenameMediaRequest({ ...request, userId });

    // Sanitize new filename (validation already checked it's valid)
    const sanitizedFilename = sanitizeFilename(request.newFilename);

    logger.info('Renaming media file', {
      userId,
      fileKey: request.fileKey,
      newFilename: sanitizedFilename,
    });

    // Rename media file in S3
    const result = await s3Service.renameMediaFile(request.fileKey, sanitizedFilename);

    // Build success response
    const response: RenameMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'File renamed successfully',
      data: result,
    };

    logger.info('Rename media request completed successfully', {
      oldKey: result.oldKey,
      newKey: result.newKey,
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
function parseRequestBody(event: APIGatewayProxyEventV2): { fileKey: string; newFilename: string } {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.fileKey || typeof body.fileKey !== 'string') {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "fileKey" field'
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
      fileKey: body.fileKey,
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
 * Handle errors and return appropriate response
 */
function handleError(
  error: unknown,
  requestId: string
): APIGatewayProxyResultV2 {
  // Handle S3ServiceError for specific cases
  if (error instanceof S3ServiceError) {
    // Check for specific error messages
    if (error.message.includes('already exists')) {
      const errorResponse: ErrorResponse = {
        statusCode: HttpStatus.CONFLICT,
        errorCode: ErrorCode.CONFLICT,
        message: 'File with this name already exists',
        details: error.details,
        requestId,
      };
      return buildApiResponse(errorResponse);
    }

    if (error.message.includes('not found')) {
      const errorResponse: ErrorResponse = {
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: ErrorCode.NOT_FOUND,
        message: 'Source file not found',
        details: error.details,
        requestId,
      };
      return buildApiResponse(errorResponse);
    }

    // Generic S3ServiceError
    const errorResponse: ErrorResponse = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: error.message,
      details: error.details,
      requestId,
    };
    return buildApiResponse(errorResponse);
  }

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
