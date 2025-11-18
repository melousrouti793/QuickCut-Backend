/**
 * List Media Handler
 * Lambda handler for listing user's media files
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  ListMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  ListMediaQueryParams,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';

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

    // Parse query parameters
    const queryParams = parseQueryParameters(event);

    // Validate query parameters
    validationService.validateListMediaQueryParams(queryParams);

    // Validate userId from query params
    validationService.validateUserId(queryParams.userId);
    logger.setContext({ userId: queryParams.userId });

    // Build params for S3 service
    const listParams: ListMediaQueryParams = {
      userId: queryParams.userId,
      mediaType: queryParams.mediaType as 'visual' | 'audio' | undefined,
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : 50,
      continuationToken: queryParams.continuationToken,
    };

    // List media files from S3
    const result = await s3Service.listMediaFiles(listParams);

    // Build success response
    const response: ListMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Media files retrieved successfully',
      data: {
        files: result.files,
        count: result.files.length,
        hasMore: result.hasMore,
        nextToken: result.nextToken,
      },
    };

    logger.info('List media request completed successfully', {
      fileCount: result.files.length,
      hasMore: result.hasMore,
      userId: queryParams.userId,
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
  userId: string;
  mediaType?: string;
  limit?: string;
  continuationToken?: string;
} {
  const queryParams = event.queryStringParameters || {};

  if (!queryParams.userId) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Query parameter "userId" is required'
    );
  }

  return {
    userId: queryParams.userId,
    mediaType: queryParams.mediaType,
    limit: queryParams.limit,
    continuationToken: queryParams.continuationToken,
  };
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
      'Access-Control-Allow-Origin': '*', // Configure based on your CORS requirements
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
