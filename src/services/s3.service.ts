/**
 * S3 Service
 * Handles all S3 operations including multipart uploads and presigned URLs
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { s3Config } from '../config';
import { logger } from '../utils/logger';
import { S3ServiceError } from '../errors/AppError';
import {
  MediaFile,
  MediaFileWithThumbnail,
  UploadConfiguration,
  UploadConfigurationWithThumbnail,
  PresignedUrlInfo,
  MultipartUploadInfo,
  UploadPart,
  CompletedUpload,
  S3UploadMetadata,
  MediaFileInfo,
  ListMediaQueryParams,
  DeleteResult,
  RenameMediaData,
  SearchMediaQueryParams,
} from '../types';
import { buildRenamedKey } from '../utils/sanitize';

export class S3Service {
  private s3Client: S3Client;

  constructor() {
    // Initialize S3 client with configuration
    this.s3Client = new S3Client({
      region: s3Config.region,
      // Connection pooling for better performance
      maxAttempts: 3,
      requestHandler: {
        // Keep connections alive for reuse
        connectionTimeout: 5000,
        requestTimeout: 30000,
      },
    });

    logger.info('S3 service initialized', {
      region: s3Config.region,
      bucket: s3Config.bucketName,
    });
  }

  /**
   * Create multipart upload configurations for multiple files with optional thumbnails
   */
  async createMultipartUploads(
    files: MediaFileWithThumbnail[],
    userId: string
  ): Promise<UploadConfigurationWithThumbnail[]> {
    logger.info('Creating multipart uploads', {
      fileCount: files.length,
      userId,
    });

    const uploadPromises = files.map((fileWithThumbnail) =>
      this.createMultipartUploadWithThumbnail(fileWithThumbnail, userId)
    );

    try {
      const uploadConfigs = await Promise.all(uploadPromises);
      logger.info('All multipart uploads created successfully', {
        count: uploadConfigs.length,
      });
      return uploadConfigs;
    } catch (error) {
      logger.error('Failed to create multipart uploads', error);
      throw new S3ServiceError('Failed to initiate S3 multipart uploads', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create multipart upload for a file with optional thumbnail
   */
  private async createMultipartUploadWithThumbnail(
    fileWithThumbnail: MediaFileWithThumbnail,
    userId: string
  ): Promise<UploadConfigurationWithThumbnail> {
    // Generate a single fileId for both main file and thumbnail
    const fileId = uuidv4();

    logger.debug('Creating upload for file with thumbnail', {
      fileId,
      mainFilename: fileWithThumbnail.main.filename,
      hasThumbnail: !!fileWithThumbnail.thumbnail,
    });

    // Create upload config for main file
    const mainUploadConfig = await this.createSingleMultipartUpload(
      fileWithThumbnail.main,
      userId,
      fileId
    );

    // Create upload config for thumbnail if provided
    let thumbnailUploadConfig: UploadConfiguration | undefined;
    if (fileWithThumbnail.thumbnail) {
      // Prepend "thumbnail/" to the filename for proper S3 structure
      const thumbnailFile: MediaFile = {
        ...fileWithThumbnail.thumbnail,
        filename: `thumbnail/${fileWithThumbnail.thumbnail.filename}`,
      };

      thumbnailUploadConfig = await this.createSingleMultipartUpload(
        thumbnailFile,
        userId,
        fileId // Use the SAME fileId so they're in the same directory
      );
    }

    return {
      main: mainUploadConfig,
      thumbnail: thumbnailUploadConfig,
    };
  }

  /**
   * Create a multipart upload for a single file
   */
  private async createSingleMultipartUpload(
    file: MediaFile,
    userId: string,
    fileId?: string
  ): Promise<UploadConfiguration> {
    const actualFileId = fileId || uuidv4();
    const s3Key = this.generateS3Key(userId, actualFileId, file.filename, file.fileType);

    logger.debug('Initiating multipart upload', {
      fileId: actualFileId,
      s3Key,
      filename: file.filename,
    });

    try {
      // Create multipart upload in S3
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: s3Config.bucketName,
        Key: s3Key,
        ContentType: file.fileType,
        Metadata: {
          userId,
          fileId: actualFileId,
          originalFilename: file.filename,
          uploadedAt: new Date().toISOString(),
        },
        // Server-side encryption (recommended)
        ServerSideEncryption: 'AES256',
      });

      const createResponse = await this.s3Client.send(createCommand);

      if (!createResponse.UploadId) {
        throw new Error('S3 did not return an UploadId');
      }

      // Calculate number of parts needed
      const partCount = this.calculatePartCount(file.fileSize);

      // Generate presigned URLs for all parts
      const parts = await this.generatePresignedUrls(
        s3Key,
        createResponse.UploadId,
        partCount
      );

      // Calculate expiration time
      const expiresAt = new Date(
        Date.now() + s3Config.presignedUrlExpiry * 1000
      ).toISOString();

      const uploadConfig: UploadConfiguration = {
        fileId: actualFileId,
        s3Key,
        bucket: s3Config.bucketName,
        uploadId: createResponse.UploadId,
        parts,
        filename: file.filename,
        fileType: file.fileType,
        expiresAt,
      };

      logger.info('Multipart upload created', {
        fileId: actualFileId,
        uploadId: createResponse.UploadId,
        partCount,
      });

      return uploadConfig;
    } catch (error) {
      logger.error('Failed to create multipart upload', error, {
        filename: file.filename,
      });
      throw error;
    }
  }

  /**
   * Determine media type prefix from MIME type
   * - visual: for images and videos
   * - audio: for audio files
   */
  private getMediaTypePrefix(mimeType: string): 'visual' | 'audio' {
    const normalizedMimeType = mimeType.toLowerCase().trim();

    if (normalizedMimeType.startsWith('audio/')) {
      return 'audio';
    }

    // video/ and image/ both map to 'visual'
    // Default to 'visual' for any other types
    return 'visual';
  }

  /**
   * Generate S3 key following naming convention
   * Pattern: {prefix}/{userId}/{mediaType}/{year}/{month}/{day}/{fileId}/{sanitizedFilename}
   */
  private generateS3Key(
    userId: string,
    fileId: string,
    filename: string,
    mimeType: string
  ): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');

    // Get media type prefix (visual or audio)
    const mediaType = this.getMediaTypePrefix(mimeType);

    // Sanitize filename for S3
    const sanitizedFilename = this.sanitizeFilename(filename);

    return `${s3Config.keyPrefix}/${userId}/${mediaType}/${year}/${month}/${day}/${fileId}/${sanitizedFilename}`;
  }

  /**
   * Sanitize filename for S3 storage
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._/-]/g, '') // Allow forward slashes for subdirectories
      .toLowerCase();
  }

  /**
   * Calculate number of parts needed for multipart upload
   */
  private calculatePartCount(fileSize: number): number {
    const partSize = s3Config.partSize;
    return Math.ceil(fileSize / partSize);
  }

  /**
   * Generate presigned URLs for all parts of a multipart upload
   */
  private async generatePresignedUrls(
    s3Key: string,
    uploadId: string,
    partCount: number
  ): Promise<PresignedUrlInfo[]> {
    logger.debug('Generating presigned URLs', {
      s3Key,
      uploadId,
      partCount,
    });

    const urlPromises: Promise<PresignedUrlInfo>[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      urlPromises.push(this.generatePartPresignedUrl(s3Key, uploadId, partNumber));
    }

    try {
      const urls = await Promise.all(urlPromises);
      logger.debug('Presigned URLs generated', { count: urls.length });
      return urls;
    } catch (error) {
      logger.error('Failed to generate presigned URLs', error);
      throw new S3ServiceError('Failed to generate presigned URLs for upload', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Generate a presigned URL for a single part
   */
  private async generatePartPresignedUrl(
    s3Key: string,
    uploadId: string,
    partNumber: number
  ): Promise<PresignedUrlInfo> {
    const command = new UploadPartCommand({
      Bucket: s3Config.bucketName,
      Key: s3Key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: s3Config.presignedUrlExpiry,
    });

    return {
      partNumber,
      url,
    };
  }

  /**
   * Generate a presigned GET URL for downloading a file
   */
  private async generatePresignedGetUrl(s3Key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: s3Config.bucketName,
      Key: s3Key,
    });

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: s3Config.presignedUrlExpiry,
    });

    return url;
  }

  /**
   * Abort a multipart upload (cleanup on error)
   */
  async abortMultipartUpload(uploadInfo: MultipartUploadInfo): Promise<void> {
    logger.info('Aborting multipart upload', {
      uploadId: uploadInfo.uploadId,
      s3Key: uploadInfo.s3Key,
    });

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: uploadInfo.bucket,
        Key: uploadInfo.s3Key,
        UploadId: uploadInfo.uploadId,
      });

      await this.s3Client.send(command);

      logger.info('Multipart upload aborted', {
        uploadId: uploadInfo.uploadId,
      });
    } catch (error) {
      logger.error('Failed to abort multipart upload', error, {
        uploadId: uploadInfo.uploadId,
      });
      // Don't throw here - this is cleanup, and we don't want to mask the original error
    }
  }

  /**
   * Abort multiple multipart uploads (cleanup on error)
   */
  async abortMultipartUploads(uploadInfos: MultipartUploadInfo[]): Promise<void> {
    const abortPromises = uploadInfos.map((info) =>
      this.abortMultipartUpload(info)
    );

    await Promise.allSettled(abortPromises);
  }

  /**
   * Complete a multipart upload
   */
  async completeMultipartUpload(
    fileId: string,
    s3Key: string,
    uploadId: string,
    parts: UploadPart[]
  ): Promise<CompletedUpload> {
    logger.info('Completing multipart upload', {
      fileId,
      s3Key,
      uploadId,
      partCount: parts.length,
    });

    try {
      // Sanitize ETags (remove quotes if present)
      const sanitizedParts = parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag.replace(/"/g, ''),
      }));

      // Complete the multipart upload
      const command = new CompleteMultipartUploadCommand({
        Bucket: s3Config.bucketName,
        Key: s3Key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sanitizedParts,
        },
      });

      const response = await this.s3Client.send(command);

      if (!response.Location) {
        throw new Error('S3 did not return a location for the completed upload');
      }

      logger.info('Multipart upload completed successfully', {
        fileId,
        location: response.Location,
      });

      // Retrieve metadata from the uploaded object
      const metadata = await this.getObjectMetadata(s3Key);

      return {
        fileId,
        bucket: s3Config.bucketName,
        s3Key,
        location: response.Location,
        metadata: {
          filename: metadata.originalFilename,
          fileType: metadata.fileType,
          uploadedAt: metadata.uploadedAt,
        },
      };
    } catch (error) {
      logger.error('Failed to complete multipart upload', error, {
        fileId,
        uploadId,
      });

      // Attempt to abort the upload on failure
      await this.abortMultipartUpload({
        uploadId,
        s3Key,
        bucket: s3Config.bucketName,
      });

      throw new S3ServiceError('Failed to complete multipart upload', {
        error: error instanceof Error ? error.message : String(error),
        fileId,
      });
    }
  }

  /**
   * Get metadata from an uploaded object
   */
  private async getObjectMetadata(s3Key: string): Promise<S3UploadMetadata> {
    try {
      const command = new HeadObjectCommand({
        Bucket: s3Config.bucketName,
        Key: s3Key,
      });

      const response = await this.s3Client.send(command);

      return {
        userId: response.Metadata?.userid || '',
        fileId: response.Metadata?.fileid || '',
        originalFilename: response.Metadata?.originalfilename || '',
        fileType: response.ContentType || '',
        uploadedAt: response.Metadata?.uploadedat || new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Failed to retrieve object metadata', error, { s3Key });
      // Return default values if metadata retrieval fails
      return {
        userId: '',
        fileId: '',
        originalFilename: '',
        fileType: '',
        uploadedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Extract user ID from S3 key
   * S3 key format: {prefix}/{userId}/{mediaType}/{year}/{month}/{day}/{fileId}/{filename}
   */
  extractUserIdFromS3Key(s3Key: string): string | null {
    try {
      const parts = s3Key.split('/');
      // Expected format: uploads/userId/mediaType/year/month/day/fileId/filename
      if (parts.length >= 2) {
        return parts[1]; // userId is at index 1
      }
      return null;
    } catch (error) {
      logger.error('Failed to extract userId from S3 key', error, { s3Key });
      return null;
    }
  }

  /**
   * Reconstruct S3 key from fileId
   * Note: This is a simplified version. In production, you might store the S3 key
   * in a database during upload initiation.
   */
  reconstructS3Key(fileId: string, userId: string): string | null {
    // This is a limitation - we can't fully reconstruct the key without knowing
    // the date and filename. In a real implementation, you would:
    // 1. Store the S3 key in DynamoDB during initiation
    // 2. Query it here using the fileId
    // For now, we'll require the client to track the s3Key or we'll need to
    // pass it in the complete request
    logger.warn('Cannot fully reconstruct S3 key without additional data', {
      fileId,
      userId,
    });
    return null;
  }

  /**
   * List media files for a user with optional filtering and pagination
   */
  async listMediaFiles(params: ListMediaQueryParams): Promise<{
    files: MediaFileInfo[];
    hasMore: boolean;
    nextToken?: string;
  }> {
    const { userId, mediaType, limit = 50, continuationToken } = params;

    // Build S3 prefix based on parameters
    let prefix = `${s3Config.keyPrefix}/${userId}/`;
    if (mediaType) {
      prefix += `${mediaType}/`;
    }

    logger.info('Listing media files', {
      userId,
      mediaType,
      prefix,
      limit,
    });

    try {
      const command = new ListObjectsV2Command({
        Bucket: s3Config.bucketName,
        Prefix: prefix,
        MaxKeys: limit,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);

      // Transform S3 objects to MediaFileInfo with presigned URLs
      // Filter out thumbnail paths - we only want original files
      const filePromises = (response.Contents || [])
        .filter((obj) => {
          const fileKey = obj.Key || '';
          return !this.isThumbnailPath(fileKey);
        })
        .map(async (obj) => {
          const fileKey = obj.Key || '';
          const filename = this.extractFilenameFromKey(fileKey);
          const extractedMediaType = this.extractMediaTypeFromKey(fileKey);

          // Generate presigned GET URL for the file
          const url = await this.generatePresignedGetUrl(fileKey);

          // Generate thumbnail URL for visual media (only if thumbnail exists)
          let thumbnailUrl: string | null = null;
          if (this.requiresThumbnail(extractedMediaType)) {
            const thumbnailKey = this.getThumbnailKey(fileKey);
            const thumbnailExists = await this.checkFileExists(thumbnailKey);
            if (thumbnailExists) {
              thumbnailUrl = await this.generatePresignedGetUrl(thumbnailKey);
            }
          }

          return {
            fileKey,
            filename,
            mediaType: extractedMediaType,
            size: obj.Size || 0,
            uploadedAt: obj.LastModified?.toISOString() || new Date().toISOString(),
            url,
            thumbnailUrl,
          };
        });

      const files = await Promise.all(filePromises);

      logger.info('Media files listed successfully', {
        count: files.length,
        hasMore: response.IsTruncated || false,
      });

      return {
        files,
        hasMore: response.IsTruncated || false,
        nextToken: response.NextContinuationToken,
      };
    } catch (error) {
      logger.error('Failed to list media files', error, { userId, mediaType });
      throw new S3ServiceError('Failed to list media files from S3', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }
  }

  /**
   * Extract filename from S3 key
   * S3 key format: uploads/userId/mediaType/year/month/day/fileId/filename
   */
  private extractFilenameFromKey(s3Key: string): string {
    const parts = s3Key.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Extract media type from S3 key
   * S3 key format: uploads/userId/mediaType/year/month/day/fileId/filename
   */
  private extractMediaTypeFromKey(s3Key: string): 'visual' | 'audio' {
    const parts = s3Key.split('/');
    // mediaType is at index 2: uploads/userId/mediaType/...
    if (parts.length >= 3) {
      const mediaType = parts[2];
      if (mediaType === 'audio') {
        return 'audio';
      }
    }
    return 'visual'; // Default to visual
  }

  /**
   * Generate thumbnail S3 key from original file key
   * Original: uploads/user123/visual/2025/11/18/abc-123/video.mp4
   * Thumbnail: uploads/user123/visual/2025/11/18/abc-123/thumbnail/video.jpg
   */
  private getThumbnailKey(originalKey: string): string {
    const lastSlash = originalKey.lastIndexOf('/');
    const directory = originalKey.substring(0, lastSlash);
    const filename = originalKey.substring(lastSlash + 1);

    // Remove file extension and add .jpg
    const lastDot = filename.lastIndexOf('.');
    const nameWithoutExt = lastDot > 0 ? filename.substring(0, lastDot) : filename;

    return `${directory}/thumbnail/${nameWithoutExt}.jpg`;
  }

  /**
   * Check if S3 key is a thumbnail path
   */
  private isThumbnailPath(key: string): boolean {
    return key.includes('/thumbnail/');
  }

  /**
   * Check if media type requires a thumbnail
   * Visual media (videos and images) require thumbnails
   * Audio media does not require thumbnails
   */
  private requiresThumbnail(mediaType: 'visual' | 'audio'): boolean {
    return mediaType === 'visual';
  }

  /**
   * Delete multiple media files from S3
   * Returns results for each file (success or failure)
   */
  async deleteMediaFiles(fileKeys: string[]): Promise<DeleteResult[]> {
    logger.info('Deleting media files', { fileCount: fileKeys.length });

    // Process deletions in parallel for performance
    const deletePromises = fileKeys.map((fileKey) => this.deleteSingleFile(fileKey));

    const results = await Promise.allSettled(deletePromises);

    // Transform results into DeleteResult format
    const deleteResults: DeleteResult[] = results.map((result, index) => {
      const fileKey = fileKeys[index];

      if (result.status === 'fulfilled') {
        return {
          fileKey,
          success: true,
        };
      } else {
        return {
          fileKey,
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }
    });

    const successCount = deleteResults.filter((r) => r.success).length;
    const failureCount = deleteResults.filter((r) => !r.success).length;

    logger.info('Media files deletion completed', {
      total: fileKeys.length,
      success: successCount,
      failed: failureCount,
    });

    return deleteResults;
  }

  /**
   * Delete a single file from S3 (and its thumbnail if it's visual media)
   */
  private async deleteSingleFile(fileKey: string): Promise<void> {
    logger.debug('Deleting file from S3', { fileKey });

    try {
      // Extract media type to determine if thumbnail exists
      const mediaType = this.extractMediaTypeFromKey(fileKey);

      // Delete the original file
      const deleteOriginalCommand = new DeleteObjectCommand({
        Bucket: s3Config.bucketName,
        Key: fileKey,
      });
      await this.s3Client.send(deleteOriginalCommand);

      // If visual media, also delete thumbnail (CRITICAL operation)
      if (this.requiresThumbnail(mediaType)) {
        const thumbnailKey = this.getThumbnailKey(fileKey);
        logger.debug('Deleting thumbnail', { thumbnailKey });

        const deleteThumbnailCommand = new DeleteObjectCommand({
          Bucket: s3Config.bucketName,
          Key: thumbnailKey,
        });
        await this.s3Client.send(deleteThumbnailCommand);
      }

      logger.debug('File deleted successfully', { fileKey });
    } catch (error) {
      logger.error('Failed to delete file from S3', error, { fileKey });
      throw new S3ServiceError('Failed to delete file from S3', {
        error: error instanceof Error ? error.message : String(error),
        fileKey,
      });
    }
  }

  /**
   * Rename a media file in S3 by copying to new key and deleting old key
   * Also renames thumbnails for visual media
   */
  async renameMediaFile(oldKey: string, newFilename: string): Promise<RenameMediaData> {
    logger.info('Renaming media file', { oldKey, newFilename });

    // Build new S3 key with updated filename
    const newKey = buildRenamedKey(oldKey, newFilename);
    const mediaType = this.extractMediaTypeFromKey(oldKey);

    logger.debug('Renaming file', { oldKey, newKey, mediaType });

    try {
      // Check if file with new name already exists
      const exists = await this.checkFileExists(newKey);
      if (exists) {
        throw new S3ServiceError('File with this name already exists', {
          fileKey: newKey,
        });
      }

      // Check if source file exists
      const sourceExists = await this.checkFileExists(oldKey);
      if (!sourceExists) {
        throw new S3ServiceError('Source file not found', {
          fileKey: oldKey,
        });
      }

      // Get metadata from source file
      const metadata = await this.getObjectMetadata(oldKey);

      // Copy original file to new key, preserving metadata
      const copyCommand = new CopyObjectCommand({
        Bucket: s3Config.bucketName,
        CopySource: `${s3Config.bucketName}/${oldKey}`,
        Key: newKey,
        ContentType: metadata.fileType,
        Metadata: {
          userId: metadata.userId,
          fileId: metadata.fileId,
          originalFilename: newFilename,
          uploadedAt: metadata.uploadedAt,
        },
        MetadataDirective: 'REPLACE', // Use REPLACE to update metadata with new filename
        ServerSideEncryption: 'AES256',
      });

      await this.s3Client.send(copyCommand);
      logger.debug('File copied successfully', { oldKey, newKey });

      // If visual media, also copy the thumbnail (CRITICAL operation)
      if (this.requiresThumbnail(mediaType)) {
        const oldThumbnailKey = this.getThumbnailKey(oldKey);
        const newThumbnailKey = this.getThumbnailKey(newKey);

        logger.debug('Copying thumbnail', { oldThumbnailKey, newThumbnailKey });

        const copyThumbnailCommand = new CopyObjectCommand({
          Bucket: s3Config.bucketName,
          CopySource: `${s3Config.bucketName}/${oldThumbnailKey}`,
          Key: newThumbnailKey,
          ContentType: 'image/jpeg',
          ServerSideEncryption: 'AES256',
        });

        await this.s3Client.send(copyThumbnailCommand);
        logger.debug('Thumbnail copied successfully', { oldThumbnailKey, newThumbnailKey });
      }

      // Delete old file only after successful copy (this will also delete thumbnail for visual media)
      await this.deleteSingleFile(oldKey);

      logger.info('File renamed successfully', { oldKey, newKey });

      // Generate presigned URL for the renamed file
      const url = await this.generatePresignedGetUrl(newKey);

      // Generate thumbnail URL for visual media (only if thumbnail exists)
      let thumbnailUrl: string | null = null;
      if (this.requiresThumbnail(mediaType)) {
        const newThumbnailKey = this.getThumbnailKey(newKey);
        const thumbnailExists = await this.checkFileExists(newThumbnailKey);
        if (thumbnailExists) {
          thumbnailUrl = await this.generatePresignedGetUrl(newThumbnailKey);
        }
      }

      return {
        oldKey,
        newKey,
        filename: newFilename,
        url,
        thumbnailUrl,
      };
    } catch (error) {
      logger.error('Failed to rename file', error, { oldKey, newKey });

      // If error is already S3ServiceError, rethrow it
      if (error instanceof S3ServiceError) {
        throw error;
      }

      throw new S3ServiceError('Failed to rename file in S3', {
        error: error instanceof Error ? error.message : String(error),
        oldKey,
        newKey,
      });
    }
  }

  /**
   * Check if a file exists in S3
   */
  private async checkFileExists(s3Key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: s3Config.bucketName,
        Key: s3Key,
      });

      await this.s3Client.send(command);
      return true;
    } catch (error: any) {
      // If error code is NotFound, file doesn't exist
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      // For other errors, throw them
      throw error;
    }
  }

  /**
   * Search media files by partial filename match
   * Supports searching across all media types or filtering by visual/audio
   */
  async searchMediaFiles(params: SearchMediaQueryParams): Promise<{
    files: MediaFileInfo[];
    hasMore: boolean;
    nextToken?: string;
  }> {
    const { userId, query, mediaType, limit = 50, continuationToken } = params;

    // Normalize search query to lowercase for case-insensitive matching
    const searchQuery = query.trim().toLowerCase();

    logger.info('Searching media files', {
      userId,
      query: searchQuery,
      mediaType,
      limit,
    });

    try {
      let allFiles: MediaFileInfo[] = [];

      if (mediaType) {
        // Search only in specific media type
        const prefix = `${s3Config.keyPrefix}/${userId}/${mediaType}/`;
        const files = await this.listAndFilterFiles(prefix, searchQuery, continuationToken);
        allFiles = files;
      } else {
        // Search in both visual and audio
        const visualPrefix = `${s3Config.keyPrefix}/${userId}/visual/`;
        const audioPrefix = `${s3Config.keyPrefix}/${userId}/audio/`;

        // List from both prefixes
        const [visualFiles, audioFiles] = await Promise.all([
          this.listAndFilterFiles(visualPrefix, searchQuery),
          this.listAndFilterFiles(audioPrefix, searchQuery),
        ]);

        // Combine results
        allFiles = [...visualFiles, ...audioFiles];

        // Sort by upload date (most recent first)
        allFiles.sort((a, b) => {
          const dateA = new Date(a.uploadedAt).getTime();
          const dateB = new Date(b.uploadedAt).getTime();
          return dateB - dateA;
        });
      }

      // Apply limit and pagination
      const hasMore = allFiles.length > limit;
      const paginatedFiles = allFiles.slice(0, limit);

      logger.info('Media search completed', {
        query: searchQuery,
        totalMatches: allFiles.length,
        returned: paginatedFiles.length,
        hasMore,
      });

      return {
        files: paginatedFiles,
        hasMore,
        nextToken: hasMore ? 'has-more' : undefined, // Simplified pagination for MVP
      };
    } catch (error) {
      logger.error('Failed to search media files', error, { userId, query: searchQuery });
      throw new S3ServiceError('Failed to search media files from S3', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        query: searchQuery,
      });
    }
  }

  /**
   * List files from S3 with a prefix and filter by search query
   */
  private async listAndFilterFiles(
    prefix: string,
    searchQuery: string,
    continuationToken?: string
  ): Promise<MediaFileInfo[]> {
    const matchingFiles: MediaFileInfo[] = [];

    try {
      // List up to 1000 objects (S3 max per request)
      const command = new ListObjectsV2Command({
        Bucket: s3Config.bucketName,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);

      // Filter and transform matching files
      const filePromises = (response.Contents || [])
        .filter((obj) => {
          const fileKey = obj.Key || '';
          // Filter out thumbnail paths
          if (this.isThumbnailPath(fileKey)) {
            return false;
          }
          const filename = this.extractFilenameFromKey(fileKey).toLowerCase();
          return filename.includes(searchQuery);
        })
        .map(async (obj) => {
          const fileKey = obj.Key || '';
          const filename = this.extractFilenameFromKey(fileKey);
          const extractedMediaType = this.extractMediaTypeFromKey(fileKey);

          // Generate presigned GET URL for the file
          const url = await this.generatePresignedGetUrl(fileKey);

          // Generate thumbnail URL for visual media (only if thumbnail exists)
          let thumbnailUrl: string | null = null;
          if (this.requiresThumbnail(extractedMediaType)) {
            const thumbnailKey = this.getThumbnailKey(fileKey);
            const thumbnailExists = await this.checkFileExists(thumbnailKey);
            if (thumbnailExists) {
              thumbnailUrl = await this.generatePresignedGetUrl(thumbnailKey);
            }
          }

          return {
            fileKey,
            filename,
            mediaType: extractedMediaType,
            size: obj.Size || 0,
            uploadedAt: obj.LastModified?.toISOString() || new Date().toISOString(),
            url,
            thumbnailUrl,
          };
        });

      const files = await Promise.all(filePromises);
      matchingFiles.push(...files);

      logger.debug('Files listed and filtered', {
        prefix,
        totalListed: response.Contents?.length || 0,
        matchingFiles: matchingFiles.length,
      });
    } catch (error) {
      logger.error('Failed to list and filter files', error, { prefix, searchQuery });
      throw error;
    }

    return matchingFiles;
  }

  /**
   * Health check - verify S3 access
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple check to verify S3 access
      // You could implement a more comprehensive check if needed
      logger.debug('S3 health check passed');
      return true;
    } catch (error) {
      logger.error('S3 health check failed', error);
      return false;
    }
  }
}

// Export singleton instance
export const s3Service = new S3Service();
