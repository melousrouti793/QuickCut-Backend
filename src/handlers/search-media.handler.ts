/**
 * Search Media Handler
 * Lambda handler for searching user's media files by partial filename
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  SearchMediaSuccessResponse,
  ErrorResponse,
  HttpStatus,
  SearchMediaQueryParams,
} from '../types';
import { AppError } from '../errors/AppError';
import { validationService } from '../services/validation.service';
import { s3Service } from '../services/s3.service';
import { logger } from '../utils/logger';
import { validateConfig } from '../config';

/**
 * Lambda handler for search media requests
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = uuidv4();

  // Set logging context
  logger.setContext({ requestId, action: 'search-media' });

  logger.info('Search media request received', {
    path: event.requestContext.http.path,
    method: event.requestContext.http.method,
  });

  try {
    // Validate configuration on cold start
    validateConfig();

    // Parse query parameters
    const queryParams = parseQueryParameters(event);

    // Validate query parameters
    validationService.validateSearchMediaQueryParams(queryParams);

    // Validate userId from query params
    validationService.validateUserId(queryParams.userId);
    logger.setContext({ userId: queryParams.userId });

    // Build params for S3 service
    const searchParams: SearchMediaQueryParams = {
      userId: queryParams.userId,
      query: queryParams.query,
      mediaType: queryParams.mediaType as 'visual' | 'audio' | undefined,
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : 50,
      continuationToken: queryParams.continuationToken,
    };

    logger.info('Searching media files', {
      userId: searchParams.userId,
      query: searchParams.query,
      mediaType: searchParams.mediaType,
      limit: searchParams.limit,
    });

    // Search media files from S3
    const result = await s3Service.searchMediaFiles(searchParams);

    // Build success response
    const response: SearchMediaSuccessResponse = {
      statusCode: HttpStatus.OK,
      message: 'Search completed successfully',
      data: {
        query: searchParams.query,
        mediaType: searchParams.mediaType,
        files: result.files,
        count: result.files.length,
        hasMore: result.hasMore,
        nextToken: result.nextToken,
      },
    };

    logger.info('Search media request completed successfully', {
      query: searchParams.query,
      matchCount: result.files.length,
      hasMore: result.hasMore,
      userId: searchParams.userId,
    });

    return buildApiResponse(response);
  } catch (error) {
    logger.error('Search media request failed', error);
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
  query: string;
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

  if (!queryParams.query) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REQUEST' as any,
      'Query parameter "query" is required'
    );
  }

  return {
    userId: queryParams.userId,
    query: queryParams.query,
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
  response: SearchMediaSuccessResponse | ErrorResponse
): APIGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'X-Request-ID': 'requestId' in response ? response.requestId || '' : '',
    },
    body: JSON.stringify(response),
  };
}
