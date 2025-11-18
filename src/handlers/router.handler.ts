/**
 * Router Handler
 * Unified entry point that routes requests to appropriate handlers based on path
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handler as initiateHandler } from './upload.handler';
import { handler as completeHandler } from './complete.handler';
import { handler as listMediaHandler } from './list-media.handler';
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

  // Route based on path and method
  switch (path) {
    case '/upload/initiate':
      if (method !== 'POST') {
        return methodNotAllowedResponse(['POST'], method);
      }
      logger.debug('Routing to initiate handler');
      return await initiateHandler(event);

    case '/upload/complete':
      if (method !== 'POST') {
        return methodNotAllowedResponse(['POST'], method);
      }
      logger.debug('Routing to complete handler');
      return await completeHandler(event);

    case '/media':
      if (method !== 'GET') {
        return methodNotAllowedResponse(['GET'], method);
      }
      logger.debug('Routing to list media handler');
      return await listMediaHandler(event);

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
            availableRoutes: ['/upload/initiate', '/upload/complete', '/media'],
          },
        }),
      };
  }
}

/**
 * Return a 405 Method Not Allowed response
 */
function methodNotAllowedResponse(
  allowedMethods: string[],
  receivedMethod: string
): APIGatewayProxyResultV2 {
  logger.warn('Method not allowed', { allowedMethods, receivedMethod });
  return {
    statusCode: 405,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': allowedMethods.join(',') + ',OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Allow': allowedMethods.join(','),
    },
    body: JSON.stringify({
      statusCode: 405,
      errorCode: 'METHOD_NOT_ALLOWED',
      message: 'Method Not Allowed',
      details: {
        allowedMethods,
        receivedMethod,
      },
    }),
  };
}
