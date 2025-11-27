/**
 * DynamoDB Service
 * Handles all DynamoDB operations for the media index
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { dynamoDBConfig } from '../config';
import { logger } from '../utils/logger';
import { DynamoDBServiceError } from '../errors/AppError';
import {
  MediaItem,
  MediaType,
  MediaFile,
  MediaFileWithThumbnail,
  UploadConfiguration,
  UploadConfigurationWithThumbnail,
} from '../types';

/**
 * Maximum items per BatchWrite request (DynamoDB limit)
 */
const MAX_BATCH_WRITE_ITEMS = 25;

export class DynamoDBService {
  private client: DynamoDBClient;
  private docClient: DynamoDBDocumentClient;

  constructor() {
    // Initialize DynamoDB client
    this.client = new DynamoDBClient({
      region: dynamoDBConfig.region,
      maxAttempts: 3,
    });

    // Create document client for simplified operations
    this.docClient = DynamoDBDocumentClient.from(this.client, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });

    logger.info('DynamoDB service initialized', {
      region: dynamoDBConfig.region,
      tableName: dynamoDBConfig.tableName,
    });
  }

  /**
   * Create media records for uploaded files
   * Called after S3 multipart uploads are initiated
   */
  async createMediaRecords(
    userId: string,
    uploadConfigs: UploadConfigurationWithThumbnail[],
    files: MediaFileWithThumbnail[]
  ): Promise<void> {
    logger.info('Creating media records in DynamoDB', {
      userId,
      fileCount: uploadConfigs.length,
    });

    // Build media items from upload configs and original file data
    const mediaItems: MediaItem[] = uploadConfigs.map((config, index) => {
      const file = files[index];
      return this.buildMediaItem(
        userId,
        config.main,
        file.main,
        config.thumbnail?.s3Key || null
      );
    });

    try {
      // Write items in batches (DynamoDB limit is 25 per batch)
      await this.batchWriteItems(mediaItems);

      logger.info('Media records created successfully', {
        userId,
        count: mediaItems.length,
      });
    } catch (error) {
      logger.error('Failed to create media records', error, { userId });
      throw new DynamoDBServiceError('Failed to create media records', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        fileCount: uploadConfigs.length,
      });
    }
  }

  /**
   * Build a MediaItem from upload data
   */
  private buildMediaItem(
    userId: string,
    uploadConfig: UploadConfiguration,
    file: MediaFile,
    thumbnailS3Key: string | null
  ): MediaItem {
    const now = new Date().toISOString();
    const mediaType = this.getMediaType(file.fileType);

    return {
      PK: `USER#${userId}`,
      SK: `MEDIA#${uploadConfig.fileId}`,
      entityType: 'MEDIA',
      mediaId: uploadConfig.fileId,
      mediaType,
      filename: file.filename,
      mimeType: file.fileType,
      sizeBytes: file.fileSize,
      s3Key: uploadConfig.s3Key,
      thumbnailS3Key,
      status: 'processing',
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Derive mediaType from MIME type (singular form for DynamoDB)
   */
  private getMediaType(mimeType: string): MediaType {
    const normalizedMimeType = mimeType.toLowerCase().trim();

    if (normalizedMimeType.startsWith('video/')) {
      return 'video';
    }

    if (normalizedMimeType.startsWith('image/')) {
      return 'image';
    }

    if (normalizedMimeType.startsWith('audio/')) {
      return 'audio';
    }

    // Default to video for unknown types
    return 'video';
  }

  /**
   * Write items to DynamoDB in batches
   * Handles the 25-item limit per BatchWrite request
   */
  private async batchWriteItems(items: MediaItem[]): Promise<void> {
    // Split items into batches of 25
    const batches: MediaItem[][] = [];
    for (let i = 0; i < items.length; i += MAX_BATCH_WRITE_ITEMS) {
      batches.push(items.slice(i, i + MAX_BATCH_WRITE_ITEMS));
    }

    logger.debug('Writing items in batches', {
      totalItems: items.length,
      batchCount: batches.length,
    });

    // Process each batch
    for (const batch of batches) {
      await this.writeBatch(batch);
    }
  }

  /**
   * Write a single batch of items to DynamoDB
   * Includes retry logic for unprocessed items
   */
  private async writeBatch(items: MediaItem[], retryCount = 0): Promise<void> {
    const maxRetries = 3;

    const params: BatchWriteCommandInput = {
      RequestItems: {
        [dynamoDBConfig.tableName]: items.map((item) => ({
          PutRequest: {
            Item: item,
          },
        })),
      },
    };

    try {
      const response = await this.docClient.send(new BatchWriteCommand(params));

      // Check for unprocessed items
      const unprocessedItems = response.UnprocessedItems?.[dynamoDBConfig.tableName];
      if (unprocessedItems && unprocessedItems.length > 0) {
        if (retryCount >= maxRetries) {
          throw new Error(
            `Failed to write ${unprocessedItems.length} items after ${maxRetries} retries`
          );
        }

        // Exponential backoff
        const delay = Math.pow(2, retryCount) * 100;
        logger.warn('Retrying unprocessed items', {
          unprocessedCount: unprocessedItems.length,
          retryCount: retryCount + 1,
          delay,
        });

        await this.sleep(delay);

        // Extract items from PutRequest and retry
        const retryItems = unprocessedItems
          .filter((req) => req.PutRequest?.Item)
          .map((req) => req.PutRequest!.Item as MediaItem);

        await this.writeBatch(retryItems, retryCount + 1);
      }

      logger.debug('Batch write successful', { itemCount: items.length });
    } catch (error) {
      logger.error('Batch write failed', error, {
        itemCount: items.length,
        retryCount,
      });
      throw error;
    }
  }

  /**
   * Sleep utility for retry backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const dynamoDBService = new DynamoDBService();
