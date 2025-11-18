/**
 * Router Handler
 * Unified entry point that routes requests to appropriate handlers based on path
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handler as initiateHandler } from './upload.handler';
import { handler as completeHandler } from './complete.handler';
import { logger } from '../utils/logger';

/**
 * Main Lambda handler that routes to appropriate endpoint handlers
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  // Extract path and method from event
  const rawPath = event.rawPath || event.requestContext.http.path;
  const method = event.requestContext.http.method;

  // Strip stage from path (e.g., /dev/upload/initiate -> /upload/initiate)
  // API Gateway includes the stage in the path, we need to remove it
  const path = rawPath.replace(/^\/[^/]+/, ''); // Remove first path segment (stage)

  logger.info('Router received request', {
    rawPath,
    path,
    method,
    requestId: event.requestContext.requestId,
  });

  // Check HTTP method - only POST is allowed
  if (method !== 'POST') {
    logger.warn('Method not allowed', { method, path });
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Allow': 'POST',
      },
      body: JSON.stringify({
        statusCode: 405,
        errorCode: 'METHOD_NOT_ALLOWED',
        message: 'Method Not Allowed',
        details: {
          allowedMethods: ['POST'],
          receivedMethod: method,
        },
      }),
    };
  }

  // Route based on path
  switch (path) {
    case '/upload/initiate':
      logger.debug('Routing to initiate handler');
      return await initiateHandler(event);

    case '/upload/complete':
      logger.debug('Routing to complete handler');
      return await completeHandler(event);

    default:
      logger.warn('Route not found', { path });
      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
        body: JSON.stringify({
          statusCode: 404,
          errorCode: 'NOT_FOUND',
          message: 'Not Found',
          details: {
            path,
            availableRoutes: ['/upload/initiate', '/upload/complete'],
          },
        }),
      };
  }
}
