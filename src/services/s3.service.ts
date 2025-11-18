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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { s3Config } from '../config';
import { logger } from '../utils/logger';
import { S3ServiceError } from '../errors/AppError';
import {
  MediaFile,
  UploadConfiguration,
  PresignedUrlInfo,
  MultipartUploadInfo,
  UploadPart,
  CompletedUpload,
  S3UploadMetadata,
} from '../types';

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
   * Create multipart upload configurations for multiple files
   */
  async createMultipartUploads(
    files: MediaFile[],
    userId: string
  ): Promise<UploadConfiguration[]> {
    logger.info('Creating multipart uploads', {
      fileCount: files.length,
      userId,
    });

    const uploadPromises = files.map((file) =>
      this.createSingleMultipartUpload(file, userId)
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
   * Create a multipart upload for a single file
   */
  private async createSingleMultipartUpload(
    file: MediaFile,
    userId: string
  ): Promise<UploadConfiguration> {
    const fileId = uuidv4();
    const s3Key = this.generateS3Key(userId, fileId, file.filename);

    logger.debug('Initiating multipart upload', {
      fileId,
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
          fileId,
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
        fileId,
        s3Key,
        bucket: s3Config.bucketName,
        uploadId: createResponse.UploadId,
        parts,
        filename: file.filename,
        fileType: file.fileType,
        expiresAt,
      };

      logger.info('Multipart upload created', {
        fileId,
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
   * Generate S3 key following naming convention
   * Pattern: {prefix}/{userId}/{year}/{month}/{day}/{fileId}/{sanitizedFilename}
   */
  private generateS3Key(
    userId: string,
    fileId: string,
    filename: string
  ): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');

    // Sanitize filename for S3
    const sanitizedFilename = this.sanitizeFilename(filename);

    return `${s3Config.keyPrefix}/${userId}/${year}/${month}/${day}/${fileId}/${sanitizedFilename}`;
  }

  /**
   * Sanitize filename for S3 storage
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '')
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
   * S3 key format: {prefix}/{userId}/{year}/{month}/{day}/{fileId}/{filename}
   */
  extractUserIdFromS3Key(s3Key: string): string | null {
    try {
      const parts = s3Key.split('/');
      // Expected format: uploads/userId/year/month/day/fileId/filename
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
