/**
 * Sanitization Utilities
 * Provides functions to sanitize and validate user inputs to prevent XSS and injection attacks
 */

import { logger } from './logger';

/**
 * Dangerous file extensions that should not be allowed
 */
const DANGEROUS_EXTENSIONS = [
  'exe',
  'bat',
  'cmd',
  'com',
  'pif',
  'scr',
  'vbs',
  'js',
  'jse',
  'wsf',
  'wsh',
  'msi',
  'msp',
  'hta',
  'cpl',
  'jar',
  'app',
  'deb',
  'rpm',
  'sh',
  'bash',
  'ps1',
  'html',
  'htm',
  'php',
  'asp',
  'aspx',
  'jsp',
];

/**
 * Allowed characters pattern for filenames
 * Alphanumeric, dash, underscore, space, dot, forward slash
 * Forward slashes allow subdirectory paths like "thumbnail/video.jpg"
 */
const FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-\.\ \/]+\.[a-zA-Z0-9]+$/;

/**
 * Allowed characters pattern for userId
 * Alphanumeric, dash, underscore only
 */
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * S3 key pattern for validation
 * Format: uploads/{userId}/{mediaType}/{year}/{month}/{day}/{fileId}/{filename}
 * OR: uploads/{userId}/{mediaType}/{year}/{month}/{day}/{fileId}/thumbnail/{filename}
 */
const S3_KEY_PATTERN =
  /^uploads\/[a-zA-Z0-9_-]+\/(visual|audio)\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9-]+\/(thumbnail\/)?[a-zA-Z0-9_\-\. ]+$/;

/**
 * Path traversal patterns to detect and block
 * Note: We check these patterns specifically, not just ".." which can appear
 * legitimately in filenames like "file...mp3"
 */
const PATH_TRAVERSAL_PATTERNS = [
  '../',      // Unix path traversal
  '..\\',     // Windows path traversal
  '..%2F',    // URL-encoded forward slash (uppercase)
  '..%2f',    // URL-encoded forward slash (lowercase)
  '..%5C',    // URL-encoded backslash (uppercase)
  '..%5c',    // URL-encoded backslash (lowercase)
  '%2e%2e/',  // Double-encoded dots with forward slash
  '%2e%2e\\', // Double-encoded dots with backslash
  '..%252F',  // Double URL-encoded forward slash
  '..%252f',  // Double URL-encoded forward slash (lowercase)
  '..%255C',  // Double URL-encoded backslash
  '..%255c',  // Double URL-encoded backslash (lowercase)
];

/**
 * Sanitize a filename to prevent XSS and injection attacks
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }

  // Trim whitespace
  let sanitized = filename.trim();

  // Check length
  if (sanitized.length === 0) {
    throw new Error('Filename cannot be empty');
  }

  if (sanitized.length > 255) {
    throw new Error('Filename exceeds maximum length of 255 characters');
  }

  // Remove HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, '');

  // Remove control characters (ASCII 0-31 and 127)
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Check for path traversal patterns BEFORE removing backslashes
  // This ensures we catch actual attacks like "../file.txt" or "..\\file.txt"
  const lowerFilename = sanitized.toLowerCase();
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (lowerFilename.includes(pattern.toLowerCase())) {
      throw new Error('Filename contains path traversal patterns');
    }
  }

  // Remove backslashes only (allow forward slashes for subdirectories like thumbnail/video.jpg)
  sanitized = sanitized.replace(/\\/g, '');

  // Replace multiple spaces with single space
  sanitized = sanitized.replace(/\s+/g, ' ');

  // Trim again after sanitization
  sanitized = sanitized.trim();

  // Cannot start with dot (hidden files)
  if (sanitized.startsWith('.')) {
    throw new Error('Filename cannot start with a dot');
  }

  // Must have an extension
  if (!sanitized.includes('.') || sanitized.endsWith('.')) {
    throw new Error('Filename must have a valid extension');
  }

  // Validate against pattern
  if (!FILENAME_PATTERN.test(sanitized)) {
    throw new Error('Filename contains invalid characters');
  }

  // Check for dangerous extensions
  const extension = sanitized.split('.').pop()?.toLowerCase() || '';
  if (DANGEROUS_EXTENSIONS.includes(extension)) {
    throw new Error(`File extension .${extension} is not allowed for security reasons`);
  }

  logger.debug('Filename sanitized', { original: filename, sanitized });

  return sanitized;
}

/**
 * Validate and sanitize userId
 */
export function sanitizeUserId(userId: string): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('UserId must be a non-empty string');
  }

  const sanitized = userId.trim();

  if (sanitized.length === 0) {
    throw new Error('UserId cannot be empty');
  }

  if (sanitized.length > 128) {
    throw new Error('UserId exceeds maximum length of 128 characters');
  }

  if (!USER_ID_PATTERN.test(sanitized)) {
    throw new Error('UserId contains invalid characters');
  }

  return sanitized;
}

/**
 * Validate S3 file key format and check for security issues
 */
export function validateFileKey(fileKey: string): void {
  if (!fileKey || typeof fileKey !== 'string') {
    throw new Error('File key must be a non-empty string');
  }

  const trimmedKey = fileKey.trim();

  // Check length
  if (trimmedKey.length === 0) {
    throw new Error('File key cannot be empty');
  }

  if (trimmedKey.length > 1024) {
    throw new Error('File key exceeds maximum length of 1024 characters');
  }

  // Check for null bytes
  if (trimmedKey.includes('\0') || trimmedKey.includes('%00')) {
    throw new Error('File key contains null bytes');
  }

  // Check for path traversal patterns
  const lowerKey = trimmedKey.toLowerCase();
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (lowerKey.includes(pattern)) {
      throw new Error('File key contains path traversal patterns');
    }
  }

  // Validate format
  if (!S3_KEY_PATTERN.test(trimmedKey)) {
    throw new Error('File key does not match expected format');
  }

  // Must start with expected prefix
  if (!trimmedKey.startsWith('uploads/')) {
    throw new Error('File key must start with "uploads/" prefix');
  }
}

/**
 * Extract userId from S3 file key
 * Format: uploads/{userId}/{mediaType}/{year}/{month}/{day}/{fileId}/{filename}
 */
export function extractUserIdFromKey(fileKey: string): string | null {
  try {
    const parts = fileKey.split('/');
    // Expected format: uploads/userId/mediaType/...
    if (parts.length >= 2 && parts[0] === 'uploads') {
      return parts[1];
    }
    return null;
  } catch (error) {
    logger.error('Failed to extract userId from file key', error, { fileKey });
    return null;
  }
}

/**
 * Authorize that a user owns a file key
 */
export function authorizeFileAccess(fileKey: string, requestUserId: string): boolean {
  const fileUserId = extractUserIdFromKey(fileKey);
  if (!fileUserId) {
    return false;
  }
  return fileUserId === requestUserId;
}

/**
 * Extract filename from S3 key
 */
export function extractFilenameFromKey(fileKey: string): string {
  const parts = fileKey.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Extract file extension from filename
 */
export function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Validate that new filename has same extension as old filename
 */
export function validateExtensionMatch(oldFilename: string, newFilename: string): void {
  const oldExt = getFileExtension(oldFilename);
  const newExt = getFileExtension(newFilename);

  if (oldExt !== newExt) {
    throw new Error(`File extension cannot be changed from .${oldExt} to .${newExt}`);
  }
}

/**
 * Build new S3 key with updated filename
 * Preserves the path structure and only changes the filename
 */
export function buildRenamedKey(originalKey: string, newFilename: string): string {
  const parts = originalKey.split('/');
  // Replace the last part (filename) with new filename
  parts[parts.length - 1] = newFilename;
  return parts.join('/');
}
