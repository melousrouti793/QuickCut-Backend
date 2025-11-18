/**
 * Validation service
 * Handles all input validation logic
 */

import { MediaFile, ValidationResult, CompleteUploadRequest, UploadPart } from '../types';
import { ErrorCode } from '../types';
import { ValidationError } from '../errors/AppError';
import { validationConfig } from '../config';
import { logger } from '../utils/logger';

export class ValidationService {
  /**
   * Validate userId field
   * TODO: Replace with API Gateway authorizer for production
   */
  validateUserId(userId: string): void {
    if (!userId || typeof userId !== 'string') {
      throw new ValidationError(
        'userId is required and must be a string',
        ErrorCode.MISSING_REQUIRED_FIELD,
        { field: 'userId' }
      );
    }

    const trimmedUserId = userId.trim();
    if (trimmedUserId.length === 0) {
      throw new ValidationError(
        'userId cannot be empty',
        ErrorCode.INVALID_REQUEST,
        { field: 'userId' }
      );
    }

    // Basic validation - alphanumeric, dash, underscore only
    const validUserIdPattern = /^[a-zA-Z0-9_-]+$/;
    if (!validUserIdPattern.test(trimmedUserId)) {
      throw new ValidationError(
        'userId can only contain alphanumeric characters, dashes, and underscores',
        ErrorCode.INVALID_REQUEST,
        { field: 'userId', value: userId }
      );
    }

    // Length check
    if (trimmedUserId.length > 128) {
      throw new ValidationError(
        'userId cannot exceed 128 characters',
        ErrorCode.INVALID_REQUEST,
        { field: 'userId' }
      );
    }

    logger.debug('UserId validation successful', { userId: trimmedUserId });
  }

  /**
   * Validate an array of media files
   */
  validateFiles(files: MediaFile[]): ValidationResult {
    const errors: string[] = [];

    // Check if files array exists and is not empty
    if (!files || !Array.isArray(files)) {
      throw new ValidationError(
        'Files must be a non-empty array',
        ErrorCode.MISSING_REQUIRED_FIELD,
        { field: 'files' }
      );
    }

    if (files.length === 0) {
      throw new ValidationError(
        'At least one file is required',
        ErrorCode.INVALID_REQUEST,
        { field: 'files' }
      );
    }

    // Check file count limit
    if (files.length > validationConfig.maxFilesPerRequest) {
      throw new ValidationError(
        `Maximum ${validationConfig.maxFilesPerRequest} files allowed per request`,
        ErrorCode.TOO_MANY_FILES,
        {
          maxFiles: validationConfig.maxFilesPerRequest,
          receivedFiles: files.length,
        }
      );
    }

    // Validate each file
    files.forEach((file, index) => {
      const fileErrors = this.validateSingleFile(file, index);
      errors.push(...fileErrors);
    });

    if (errors.length > 0) {
      throw new ValidationError(
        'File validation failed',
        ErrorCode.INVALID_REQUEST,
        { validationErrors: errors }
      );
    }

    logger.info('File validation successful', { fileCount: files.length });

    return {
      isValid: true,
      errors: [],
    };
  }

  /**
   * Validate a single file
   */
  private validateSingleFile(file: MediaFile, index: number): string[] {
    const errors: string[] = [];

    // Validate required fields
    if (!file.filename) {
      errors.push(`File at index ${index}: filename is required`);
    }

    if (!file.fileType) {
      errors.push(`File at index ${index}: fileType is required`);
    }

    if (file.fileSize === undefined || file.fileSize === null) {
      errors.push(`File at index ${index}: fileSize is required`);
    }

    // If required fields are missing, skip further validation
    if (errors.length > 0) {
      return errors;
    }

    // Validate filename
    const filenameErrors = this.validateFilename(file.filename, index);
    errors.push(...filenameErrors);

    // Validate file type
    const fileTypeErrors = this.validateFileType(file.fileType, index);
    errors.push(...fileTypeErrors);

    // Validate file size
    const fileSizeErrors = this.validateFileSize(file.fileSize, index);
    errors.push(...fileSizeErrors);

    return errors;
  }

  /**
   * Validate filename
   */
  private validateFilename(filename: string, index: number): string[] {
    const errors: string[] = [];

    if (filename.length > validationConfig.maxFilenameLength) {
      errors.push(
        `File at index ${index}: filename exceeds maximum length of ${validationConfig.maxFilenameLength} characters`
      );
    }

    // Check for dangerous characters
    const dangerousChars = /[<>:"|?*\x00-\x1f]/;
    if (dangerousChars.test(filename)) {
      errors.push(
        `File at index ${index}: filename contains invalid characters`
      );
    }

    // Check for path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      errors.push(
        `File at index ${index}: filename cannot contain path separators or traversal patterns`
      );
    }

    // Filename should have an extension
    if (!filename.includes('.')) {
      errors.push(`File at index ${index}: filename must have an extension`);
    }

    return errors;
  }

  /**
   * Validate file type (MIME type)
   */
  private validateFileType(fileType: string, index: number): string[] {
    const errors: string[] = [];

    // Normalize MIME type
    const normalizedType = fileType.toLowerCase().trim();

    if (!validationConfig.allowedMimeTypes.includes(normalizedType)) {
      errors.push(
        `File at index ${index}: file type '${fileType}' is not allowed. Allowed types: ${validationConfig.allowedMimeTypes.join(', ')}`
      );
    }

    return errors;
  }

  /**
   * Validate file size
   */
  private validateFileSize(fileSize: number, index: number): string[] {
    const errors: string[] = [];

    if (!Number.isInteger(fileSize) || fileSize < 0) {
      errors.push(`File at index ${index}: fileSize must be a positive integer`);
      return errors;
    }

    if (fileSize < validationConfig.minFileSize) {
      errors.push(
        `File at index ${index}: file size ${this.formatBytes(fileSize)} is below minimum of ${this.formatBytes(validationConfig.minFileSize)}`
      );
    }

    if (fileSize > validationConfig.maxFileSize) {
      errors.push(
        `File at index ${index}: file size ${this.formatBytes(fileSize)} exceeds maximum of ${this.formatBytes(validationConfig.maxFileSize)}`
      );
    }

    return errors;
  }

  /**
   * Sanitize filename to make it safe for S3
   */
  sanitizeFilename(filename: string): string {
    // Remove any path components
    const basename = filename.split(/[/\\]/).pop() || filename;

    // Replace spaces with underscores
    // Remove any characters that aren't alphanumeric, dash, underscore, or period
    const sanitized = basename
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '');

    return sanitized;
  }

  /**
   * Validate completion request
   */
  validateCompleteUploadRequest(request: CompleteUploadRequest): ValidationResult {
    const errors: string[] = [];

    // Validate required fields
    if (!request.fileId) {
      errors.push('fileId is required');
    }

    if (!request.s3Key) {
      errors.push('s3Key is required');
    }

    if (!request.uploadId) {
      errors.push('uploadId is required');
    }

    if (!request.parts || !Array.isArray(request.parts)) {
      errors.push('parts must be a non-empty array');
    }

    // If required fields are missing, return early
    if (errors.length > 0) {
      throw new ValidationError(
        'Complete upload validation failed',
        ErrorCode.MISSING_REQUIRED_FIELD,
        { validationErrors: errors }
      );
    }

    // Validate fileId format (UUID v4)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(request.fileId)) {
      errors.push('fileId must be a valid UUID');
    }

    // Validate s3Key format
    if (request.s3Key.includes('..') || request.s3Key.startsWith('/')) {
      errors.push('s3Key contains invalid path patterns');
    }

    // Validate uploadId (basic check - not empty, reasonable length)
    if (request.uploadId.length < 10 || request.uploadId.length > 1024) {
      errors.push('uploadId has invalid length');
    }

    // Validate parts array
    const partsErrors = this.validateParts(request.parts);
    errors.push(...partsErrors);

    if (errors.length > 0) {
      throw new ValidationError(
        'Complete upload validation failed',
        ErrorCode.INVALID_REQUEST,
        { validationErrors: errors }
      );
    }

    logger.info('Complete upload validation successful', {
      fileId: request.fileId,
      partCount: request.parts.length,
    });

    return {
      isValid: true,
      errors: [],
    };
  }

  /**
   * Validate parts array
   */
  private validateParts(parts: UploadPart[]): string[] {
    const errors: string[] = [];

    if (parts.length === 0) {
      errors.push('parts array cannot be empty');
      return errors;
    }

    // Check for duplicate part numbers
    const partNumbers = new Set<number>();

    parts.forEach((part, index) => {
      // Validate part structure
      if (!part.partNumber || !part.etag) {
        errors.push(`Part at index ${index}: partNumber and etag are required`);
        return;
      }

      // Validate part number
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10000) {
        errors.push(`Part at index ${index}: partNumber must be between 1 and 10000`);
      }

      // Check for duplicate part numbers
      if (partNumbers.has(part.partNumber)) {
        errors.push(`Duplicate part number: ${part.partNumber}`);
      }
      partNumbers.add(part.partNumber);

      // Validate ETag format (basic check)
      if (typeof part.etag !== 'string' || part.etag.trim().length === 0) {
        errors.push(`Part at index ${index}: etag must be a non-empty string`);
      }

      // ETag should be at least 32 characters (MD5 hash)
      const cleanEtag = part.etag.replace(/"/g, '');
      if (cleanEtag.length < 32) {
        errors.push(`Part at index ${index}: etag appears to be invalid`);
      }
    });

    // Verify parts are in ascending order
    const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const isOrdered = parts.every((part, index) => part.partNumber === sortedParts[index].partNumber);

    if (!isOrdered) {
      errors.push('Parts must be provided in ascending order by partNumber');
    }

    // Verify part numbers are sequential (no gaps)
    const expectedPartNumbers = Array.from({ length: parts.length }, (_, i) => i + 1);
    const actualPartNumbers = sortedParts.map(p => p.partNumber);
    const hasGaps = !expectedPartNumbers.every((expected, index) => expected === actualPartNumbers[index]);

    if (hasGaps) {
      errors.push('Parts must be sequential (no gaps in part numbers)');
    }

    return errors;
  }

  /**
   * Validate list media query parameters
   */
  validateListMediaQueryParams(params: {
    userId?: string;
    mediaType?: string;
    limit?: string;
    continuationToken?: string;
  }): void {
    const errors: string[] = [];

    // Validate userId (required)
    if (!params.userId || typeof params.userId !== 'string') {
      errors.push('userId is required');
    } else {
      try {
        this.validateUserId(params.userId);
      } catch (error) {
        if (error instanceof ValidationError) {
          errors.push(error.message);
        }
      }
    }

    // Validate mediaType (optional)
    if (params.mediaType) {
      if (params.mediaType !== 'visual' && params.mediaType !== 'audio') {
        errors.push('mediaType must be either "visual" or "audio"');
      }
    }

    // Validate limit (optional)
    if (params.limit) {
      const limitNum = parseInt(params.limit, 10);
      if (isNaN(limitNum)) {
        errors.push('limit must be a valid number');
      } else if (limitNum < 1 || limitNum > 1000) {
        errors.push('limit must be between 1 and 1000');
      }
    }

    // continuationToken is just a string, no specific validation needed

    if (errors.length > 0) {
      throw new ValidationError(
        'List media validation failed',
        ErrorCode.INVALID_REQUEST,
        { validationErrors: errors }
      );
    }

    logger.debug('List media query params validation successful');
  }

  /**
   * Format bytes to human-readable format
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
}

// Export singleton instance
export const validationService = new ValidationService();
