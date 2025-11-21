/**
 * Core type definitions for the media upload system
 */

// ============================================================================
// Request Types
// ============================================================================

export interface MediaFile {
  /** Original filename */
  filename: string;
  /** MIME type of the file */
  fileType: string;
  /** Size in bytes */
  fileSize: number;
}

export interface MediaFileWithThumbnail {
  /** Main file (video, image, or audio) */
  main: MediaFile;
  /** Optional thumbnail (only for visual media like videos) */
  thumbnail?: MediaFile;
}

export interface UploadRequest {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** Array of media files to upload (with optional thumbnails) */
  files: MediaFileWithThumbnail[];
}

export interface UploadPart {
  /** Part number (1-indexed) */
  partNumber: number;
  /** ETag returned by S3 for this part */
  etag: string;
}

export interface CompleteUploadRequest {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** File ID from initiate response */
  fileId: string;
  /** S3 key from initiate response */
  s3Key: string;
  /** S3 multipart upload ID */
  uploadId: string;
  /** Array of uploaded parts with ETags */
  parts: UploadPart[];
}

export interface ListMediaQueryParams {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** Filter by media type (visual or audio) */
  mediaType?: 'visual' | 'audio';
  /** Number of items per page (default: 50, max: 1000) */
  limit?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
}

export interface AuthContext {
  /** User ID from the authorizer */
  userId: string;
  /** User email */
  email?: string;
  /** Additional user claims */
  claims?: Record<string, string>;
}

// ============================================================================
// Response Types
// ============================================================================

export interface PresignedUrlInfo {
  /** Part number (1-indexed) */
  partNumber: number;
  /** Presigned URL for uploading this part */
  url: string;
}

export interface UploadConfiguration {
  /** Unique identifier for the file upload */
  fileId: string;
  /** S3 key where the file will be stored */
  s3Key: string;
  /** S3 bucket name */
  bucket: string;
  /** Upload ID from S3 multipart upload */
  uploadId: string;
  /** Array of presigned URLs for each part */
  parts: PresignedUrlInfo[];
  /** Original filename */
  filename: string;
  /** File type */
  fileType: string;
  /** Expiration time for presigned URLs (ISO 8601) */
  expiresAt: string;
}

export interface UploadConfigurationWithThumbnail {
  /** Upload configuration for the main file */
  main: UploadConfiguration;
  /** Upload configuration for the thumbnail (if provided) */
  thumbnail?: UploadConfiguration;
}

export interface CompletedUpload {
  /** Unique identifier for the file */
  fileId: string;
  /** S3 bucket name */
  bucket: string;
  /** S3 key where the file is stored */
  s3Key: string;
  /** Full S3 location URL */
  location: string;
  /** File metadata */
  metadata: {
    filename: string;
    fileType: string;
    uploadedAt: string;
  };
}

export interface SuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** Array of upload configurations with optional thumbnails */
  data: {
    uploads: UploadConfigurationWithThumbnail[];
    /** Total number of media items (each may have main + thumbnail) */
    totalFiles: number;
  };
}

export interface CompleteSuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** Completed upload data */
  data: CompletedUpload;
}

export interface MediaFileInfo {
  /** S3 key for the file */
  fileKey: string;
  /** Original filename */
  filename: string;
  /** Media type (visual or audio) */
  mediaType: 'visual' | 'audio';
  /** File size in bytes */
  size: number;
  /** Upload timestamp */
  uploadedAt: string;
  /** S3 URL for the file */
  url: string;
  /** Presigned URL for thumbnail (always present for visual media, null for audio) */
  thumbnailUrl: string | null;
}

export interface ListMediaSuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** List of media files */
  data: {
    files: MediaFileInfo[];
    /** Number of files returned */
    count: number;
    /** Whether more results are available */
    hasMore: boolean;
    /** Token for next page */
    nextToken?: string;
  };
}

export interface ErrorResponse {
  /** HTTP status code */
  statusCode: number;
  /** Error code for client-side handling */
  errorCode: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details (optional) */
  details?: Record<string, unknown>;
  /** Request ID for tracking */
  requestId?: string;
}

export type ApiResponse = SuccessResponse | CompleteSuccessResponse | ErrorResponse;

// ============================================================================
// Configuration Types
// ============================================================================

export interface ValidationConfig {
  /** Maximum file size in bytes (default: 5GB) */
  maxFileSize: number;
  /** Minimum file size in bytes (default: 1 byte) */
  minFileSize: number;
  /** Maximum number of files per request */
  maxFilesPerRequest: number;
  /** Allowed MIME types */
  allowedMimeTypes: string[];
  /** Maximum filename length */
  maxFilenameLength: number;
}

export interface S3Config {
  /** S3 bucket name for uploads */
  bucketName: string;
  /** S3 region */
  region: string;
  /** Prefix for S3 keys */
  keyPrefix: string;
  /** Multipart upload part size (default: 5MB) */
  partSize: number;
  /** Presigned URL expiration in seconds (default: 3600) */
  presignedUrlExpiry: number;
}

export interface RateLimitConfig {
  /** Maximum requests per user per time window */
  maxRequestsPerWindow: number;
  /** Time window in seconds */
  windowSeconds: number;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface MultipartUploadInfo {
  uploadId: string;
  s3Key: string;
  bucket: string;
}

export interface S3UploadMetadata {
  userId: string;
  fileId: string;
  originalFilename: string;
  fileType: string;
  uploadedAt: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

// ============================================================================
// Delete Media Types
// ============================================================================

export interface DeleteMediaRequest {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** Array of S3 file keys to delete */
  fileKeys: string[];
}

export interface DeleteResult {
  /** S3 file key */
  fileKey: string;
  /** Whether deletion succeeded */
  success: boolean;
  /** Error message if deletion failed */
  error?: string;
}

export interface DeleteMediaData {
  /** Successfully deleted file keys */
  deleted: string[];
  /** Failed deletions with error details */
  failed: DeleteResult[];
  /** Total number of files requested for deletion */
  totalRequested: number;
  /** Number of successful deletions */
  successCount: number;
  /** Number of failed deletions */
  failureCount: number;
}

export interface DeleteMediaSuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** Delete operation results */
  data: DeleteMediaData;
}

// ============================================================================
// Rename Media Types
// ============================================================================

export interface RenameMediaRequest {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** Original S3 file key */
  fileKey: string;
  /** New filename (sanitized) */
  newFilename: string;
}

export interface RenameMediaData {
  /** Original S3 file key */
  oldKey: string;
  /** New S3 file key */
  newKey: string;
  /** New filename */
  filename: string;
  /** Presigned URL for the renamed file */
  url: string;
  /** Presigned URL for thumbnail (present for visual media, null for audio) */
  thumbnailUrl: string | null;
}

export interface RenameMediaSuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** Rename operation result */
  data: RenameMediaData;
}

// ============================================================================
// Search Media Types
// ============================================================================

export interface SearchMediaQueryParams {
  /** User ID (temporary - will be replaced with API Gateway authorizer in production) */
  userId: string;
  /** Search query string (partial filename to search for) */
  query: string;
  /** Filter by media type (visual or audio), omit for both */
  mediaType?: 'visual' | 'audio';
  /** Number of items per page (default: 50, max: 1000) */
  limit?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
}

export interface SearchMediaData {
  /** Search query that was used */
  query: string;
  /** Media type filter applied (if any) */
  mediaType?: 'visual' | 'audio';
  /** List of matching media files */
  files: MediaFileInfo[];
  /** Number of files returned */
  count: number;
  /** Whether more results are available */
  hasMore: boolean;
  /** Token for next page */
  nextToken?: string;
}

export interface SearchMediaSuccessResponse {
  /** HTTP status code */
  statusCode: 200;
  /** Success message */
  message: string;
  /** Search results */
  data: SearchMediaData;
}

// ============================================================================
// Error Code Enum
// ============================================================================

export enum ErrorCode {
  // Client errors (4xx)
  INVALID_REQUEST = 'INVALID_REQUEST',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  FILE_TOO_SMALL = 'FILE_TOO_SMALL',
  TOO_MANY_FILES = 'TOO_MANY_FILES',
  INVALID_FILENAME = 'INVALID_FILENAME',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_FILE_ID = 'INVALID_FILE_ID',
  INVALID_UPLOAD_ID = 'INVALID_UPLOAD_ID',
  INVALID_PARTS = 'INVALID_PARTS',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Server errors (5xx)
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  S3_SERVICE_ERROR = 'S3_SERVICE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
}

// ============================================================================
// HTTP Status Codes
// ============================================================================

export enum HttpStatus {
  OK = 200,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409,
  TOO_MANY_REQUESTS = 429,
  INTERNAL_SERVER_ERROR = 500,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
}
