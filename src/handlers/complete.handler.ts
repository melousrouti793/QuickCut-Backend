/**
 * Complete Upload Handler
 * Lambda handler for completing multipart uploads
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  CompleteUploadRequest,
  CompleteSuccessResponse,
  ErrorResponse,
  HttpStatus,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
import { dynamoDBService } from '../services/dynamodb.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';
import { getAuthenticatedUserId } from '../utils/auth';

/**
 * Lambda handler for complete upload requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'complete-upload' });

  logger.info('Complete upload request received', {
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
    logger.info('Step 1: Parsing complete upload request');
    const request = parseRequestBody(event);
    logger.info('Step 1: Request parsed', {
      fileId: request.fileId,
      partCount: request.parts.length,
    });

    // Step 2: Validate completion request
    logger.info('Step 2: Validating complete upload request', {
      fileId: request.fileId,
      partCount: request.parts.length,
    });
    validationService.validateCompleteUploadRequest(request);
    logger.info('Step 2: Validation passed');

    // Step 3: Complete the multipart upload
    logger.info('Step 3: Completing S3 multipart upload', {
      fileId: request.fileId,
      s3Key: request.s3Key,
      uploadId: request.uploadId,
      partCount: request.parts.length,
    });
    const completedUpload = await s3Service.completeMultipartUpload(
      request.fileId,
      request.s3Key,
      request.uploadId,
      request.parts
    );
    logger.info('Step 3: S3 multipart upload completed', {
      fileId: request.fileId,
      location: completedUpload.location,
    });

    // Step 4: Update user profile stats (atomic increment)
    logger.info('Step 4: Updating user profile stats', { fileId: request.fileId });
    const mediaItem = await dynamoDBService.getMediaItem(userId, request.fileId);
    if (mediaItem) {
      await dynamoDBService.incrementUserStats(
        userId,
        mediaItem.mediaType,
        mediaItem.sizeBytes
      );
      logger.info('Step 4: User stats updated', {
        fileId: request.fileId,
        mediaType: mediaItem.mediaType,
        sizeBytes: mediaItem.sizeBytes,
      });
    } else {
      logger.warn('Step 4: Media item not found for stats update', {
        fileId: request.fileId,
      });
    }

    // Note: Status remains 'processing' until server-side processing
    // (preview/thumbnail generation) completes and sets it to 'ready'

    // Step 5: Build success response
    logger.info('Step 5: Building response', { fileId: request.fileId });
    const response: CompleteSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Upload completed successfully',
      data: completedUpload,
    };

    logger.info('Complete upload request completed successfully', {
      fileId: request.fileId,
      s3Key: request.s3Key,
      userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Complete upload request failed', error);
    return handleError(error, requestId);
  } finally {
    logger.clearContext();
  }
}

/**
 * Parse and validate request body
 */
function parseRequestBody(event: APIGatewayProxyEventV2): CompleteUploadRequest {
  if (!event.body) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Request body is required'
    );
  }

  try {
    const body = JSON.parse(event.body);

    // Validate required fields exist
    if (!body.fileId || !body.s3Key || !body.uploadId || !body.parts) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REQUEST' as any,
        'Request must contain fileId, s3Key, uploadId, and parts'
      );
    }

    return body as CompleteUploadRequest;
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
      // Don't expose internal details to clients - they're logged to CloudWatch
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
  response: CompleteSuccessResponse | ErrorResponse
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
