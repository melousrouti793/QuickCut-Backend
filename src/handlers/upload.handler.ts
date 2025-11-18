/**
 * Upload Handler
 * Main Lambda handler for media upload requests
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { UploadRequest, SuccessResponse, ErrorResponse, HttpStatus } from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';

/**
 * Main Lambda handler for upload requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'media-upload' });

  logger.info('Upload request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    // Validate configuration on cold start
    validateConfig();

    // Parse request body
    const request = parseRequestBody(event);

    // TODO: Replace with API Gateway authorizer for production
    // For MVP, userId is passed in request body for testing
    // Validate userId from request body
    validationService.validateUserId(request.userId);
    logger.setContext({ userId: request.userId });

    // Validate files
    validationService.validateFiles(request.files);

    // Create multipart uploads and generate presigned URLs
    const uploadConfigs = await s3Service.createMultipartUploads(
      request.files,
      request.userId
    );

    // Build success response
    const response: SuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Upload URLs generated successfully',
      data: {
        uploads: uploadConfigs,
        totalFiles: uploadConfigs.length,
      },
    };

    logger.info('Upload request completed successfully', {
      fileCount: uploadConfigs.length,
      userId: request.userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Upload request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse and validate request body
 */
function parseRequestBody(event: APIGatewayProxyEventV2): UploadRequest {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    if (!body.userId || typeof body.userId !== 'string') {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "userId" field'
      );
    }

    if (!body.files || !Array.isArray(body.files)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain a "files" array'
      );
    }

    return body as UploadRequest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Invalid JSON in request body'
      );
    }
    throw error;
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
  response: SuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Configure based on your CORS requirements
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
