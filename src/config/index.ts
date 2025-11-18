/**
 * Configuration module
 * Centralizes all environment variables and application settings
 */

import { S3Config, ValidationConfig, RateLimitConfig } from '../types';

/**
 * Get required environment variable or throw error
 */
function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

/**
 * Get optional environment variable with default
 */
function getEnvVarOptional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get numeric environment variable with default
 */
function getEnvVarNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
  }
  return parsed;
}

// ============================================================================
// S3 Configuration
// ============================================================================

export const s3Config: S3Config = {
  bucketName: getEnvVar('S3_BUCKET_NAME'),
  region: getEnvVarOptional('AWS_REGION', 'us-east-1'),
  keyPrefix: getEnvVarOptional('S3_KEY_PREFIX', 'uploads'),
  partSize: getEnvVarNumber('S3_PART_SIZE', 10 * 1024 * 1024), // 10MB default
  presignedUrlExpiry: getEnvVarNumber('PRESIGNED_URL_EXPIRY', 3600), // 1 hour
};

// ============================================================================
// Validation Configuration
// ============================================================================

export const validationConfig: ValidationConfig = {
  maxFileSize: getEnvVarNumber('MAX_FILE_SIZE', 5 * 1024 * 1024 * 1024), // 5GB default
  minFileSize: getEnvVarNumber('MIN_FILE_SIZE', 1), // 1 byte default
  maxFilesPerRequest: getEnvVarNumber('MAX_FILES_PER_REQUEST', 10),
  maxFilenameLength: getEnvVarNumber('MAX_FILENAME_LENGTH', 255),
  allowedMimeTypes: getEnvVarOptional(
    'ALLOWED_MIME_TYPES',
    'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/x-msvideo,audio/mpeg,audio/wav'
  ).split(','),
};

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

export const rateLimitConfig: RateLimitConfig = {
  maxRequestsPerWindow: getEnvVarNumber('RATE_LIMIT_MAX_REQUESTS', 100),
  windowSeconds: getEnvVarNumber('RATE_LIMIT_WINDOW_SECONDS', 3600), // 1 hour
};

// ============================================================================
// General Configuration
// ============================================================================

export const appConfig = {
  environment: getEnvVarOptional('ENVIRONMENT', 'development'),
  logLevel: getEnvVarOptional('LOG_LEVEL', 'info'),
  enableDetailedErrors: getEnvVarOptional('ENABLE_DETAILED_ERRORS', 'false') === 'true',
  corsOrigin: getEnvVarOptional('CORS_ORIGIN', '*'),
};

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate all configuration on startup
 */
export function validateConfig(): void {
  // Validate S3 config
  if (!s3Config.bucketName) {
    throw new Error('S3_BUCKET_NAME must be configured');
  }

  if (s3Config.partSize < 5 * 1024 * 1024) {
    throw new Error('S3_PART_SIZE must be at least 5MB (5242880 bytes)');
  }

  if (s3Config.presignedUrlExpiry < 60 || s3Config.presignedUrlExpiry > 604800) {
    throw new Error('PRESIGNED_URL_EXPIRY must be between 60 and 604800 seconds');
  }

  // Validate validation config
  if (validationConfig.maxFileSize < validationConfig.minFileSize) {
    throw new Error('MAX_FILE_SIZE must be greater than MIN_FILE_SIZE');
  }

  if (validationConfig.maxFilesPerRequest < 1 || validationConfig.maxFilesPerRequest > 100) {
    throw new Error('MAX_FILES_PER_REQUEST must be between 1 and 100');
  }

  if (validationConfig.allowedMimeTypes.length === 0) {
    throw new Error('ALLOWED_MIME_TYPES must contain at least one MIME type');
  }

  // Validate rate limit config
  if (rateLimitConfig.maxRequestsPerWindow < 1) {
    throw new Error('RATE_LIMIT_MAX_REQUESTS must be at least 1');
  }

  if (rateLimitConfig.windowSeconds < 60) {
    throw new Error('RATE_LIMIT_WINDOW_SECONDS must be at least 60 seconds');
  }
}
