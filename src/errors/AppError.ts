/**
 * Custom error classes for the application
 * Provides structured error handling with appropriate HTTP status codes
 */

import { ErrorCode, HttpStatus } from '../types';

/**
 * Base application error class
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: HttpStatus,
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    errorCode: ErrorCode = ErrorCode.INVALID_REQUEST,
    details?: Record<string, unknown>
  ) {
    super(HttpStatus.BAD_REQUEST, errorCode, message, details);
  }
}

/**
 * Authentication error (401)
 */
export class AuthenticationError extends AppError {
  constructor(
    message: string = 'Authentication required',
    details?: Record<string, unknown>
  ) {
    super(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED, message, details);
  }
}

/**
 * Authorization error (403)
 */
export class AuthorizationError extends AppError {
  constructor(
    message: string = 'Insufficient permissions',
    details?: Record<string, unknown>
  ) {
    super(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message, details);
  }
}

/**
 * Rate limit error (429)
 */
export class RateLimitError extends AppError {
  constructor(
    message: string = 'Rate limit exceeded',
    details?: Record<string, unknown>
  ) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.RATE_LIMIT_EXCEEDED,
      message,
      details
    );
  }
}

/**
 * S3 service error (500)
 */
export class S3ServiceError extends AppError {
  constructor(
    message: string = 'S3 service error occurred',
    details?: Record<string, unknown>
  ) {
    super(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.S3_SERVICE_ERROR,
      message,
      details
    );
  }
}

/**
 * Generic internal server error (500)
 */
export class InternalServerError extends AppError {
  constructor(
    message: string = 'An unexpected error occurred',
    details?: Record<string, unknown>
  ) {
    super(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_SERVER_ERROR,
      message,
      details
    );
  }
}
