/**
 * Authentication utilities
 * Functions for extracting and validating authorizer context
 */

import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AppError } from '../errors/AppError';
import { HttpStatus, ErrorCode } from '../types';
import { logger } from './logger';

/**
 * Authorizer context interface
 * This matches the context returned by the API Gateway Lambda authorizer
 */
export interface AuthorizerContext {
  userId: string;
  userEmail?: string;
  sessionId?: string;
}

/**
 * Extract and validate authorizer context from API Gateway event
 *
 * The authorizer validates the session and passes the authenticated user's
 * information in event.requestContext.authorizer
 *
 * @param event - API Gateway event
 * @returns Validated authorizer context with userId
 * @throws AppError with 401 UNAUTHORIZED if context is missing or invalid
 */
export function extractAuthContext(event: APIGatewayProxyEventV2): AuthorizerContext {
  // Check if authorizer context exists
  // @ts-ignore - authorizer is present when using Lambda authorizer but not in type definition
  const authorizer = event.requestContext.authorizer;

  if (!authorizer) {
    logger.warn('Missing authorizer context in request', {
      path: event.requestContext.http.path,
    });

    throw new AppError(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.UNAUTHORIZED,
      'Authentication required'
    );
  }

  // API Gateway wraps Lambda authorizer context in a 'lambda' property
  const authData = authorizer.lambda || authorizer;

  logger.debug('Auth data extraction', {
    hasLambdaProperty: !!authorizer.lambda,
    authData,
    authDataKeys: Object.keys(authData),
  });

  // Extract userId from authorizer context
  const userId = authData.userId;

  logger.debug('UserId extraction', {
    userId,
    userIdType: typeof userId,
    authDataUserId: authData.userId,
  });

  if (!userId || typeof userId !== 'string') {
    logger.warn('Missing or invalid userId in authorizer context', {
      authorizer,
      authData,
      userId,
      userIdType: typeof userId,
    });

    throw new AppError(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.UNAUTHORIZED,
      'Authentication required'
    );
  }

  // Build authorizer context object
  const authContext: AuthorizerContext = {
    userId,
    userEmail: typeof authData.userEmail === 'string' ? authData.userEmail : undefined,
    sessionId: typeof authData.sessionId === 'string' ? authData.sessionId : undefined,
  };

  logger.debug('Authorizer context extracted successfully', {
    userId: authContext.userId,
    hasEmail: !!authContext.userEmail,
    hasSessionId: !!authContext.sessionId,
  });

  return authContext;
}

/**
 * Get authenticated user ID from event
 * Convenience function that extracts just the userId
 *
 * @param event - API Gateway event
 * @returns Authenticated user ID
 * @throws AppError with 401 UNAUTHORIZED if authentication is missing
 */
export function getAuthenticatedUserId(event: APIGatewayProxyEventV2): string {
  const authContext = extractAuthContext(event);
  return authContext.userId;
}
