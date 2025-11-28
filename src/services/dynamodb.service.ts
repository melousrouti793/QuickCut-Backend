/**
 * DynamoDB Service
 * Handles all DynamoDB operations for the media index
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  BatchWriteCommandInput,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { dynamoDBConfig } from '../config';
import { logger } from '../utils/logger';
import { DynamoDBServiceError } from '../errors/AppError';
import {
  MediaItem,
  MediaType,
  MediaStatus,
  MediaFile,
  UploadConfiguration,
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
    uploadConfigs: UploadConfiguration[],
    files: MediaFile[]
  ): Promise<void> {
    logger.info('Creating media records in DynamoDB', {
      userId,
      fileCount: uploadConfigs.length,
    });

    // Build media items from upload configs and original file data
    const mediaItems: MediaItem[] = uploadConfigs.map((config, index) => {
      const file = files[index];
      return this.buildMediaItem(userId, config, file);
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
   * previewS3Key and thumbnailS3Key are set to null initially
   * Server-side processing will populate these after upload completes
   */
  private buildMediaItem(
    userId: string,
    uploadConfig: UploadConfiguration,
    file: MediaFile
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
      previewS3Key: null,
      thumbnailS3Key: null,
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

  /**
   * Query user's media items from DynamoDB
   * Returns paginated results with optional filtering
   */
  async getMediaByUser(
    userId: string,
    options?: {
      mediaType?: MediaType;
      status?: MediaStatus;
      limit?: number;
      exclusiveStartKey?: Record<string, any>;
    }
  ): Promise<{ items: MediaItem[]; lastEvaluatedKey?: Record<string, any> }> {
    const { mediaType, status = 'ready', limit = 50, exclusiveStartKey } = options || {};

    logger.debug('Querying media by user', { userId, mediaType, status, limit });

    try {
      // Build filter expression
      const filterExpressions: string[] = [];
      const expressionAttributeValues: Record<string, any> = {
        ':pk': `USER#${userId}`,
        ':skPrefix': 'MEDIA#',
      };
      const expressionAttributeNames: Record<string, string> = {};

      // Always filter by status
      filterExpressions.push('#status = :status');
      expressionAttributeValues[':status'] = status;
      expressionAttributeNames['#status'] = 'status';

      // Optionally filter by mediaType
      if (mediaType) {
        filterExpressions.push('mediaType = :mediaType');
        expressionAttributeValues[':mediaType'] = mediaType;
      }

      const command = new QueryCommand({
        TableName: dynamoDBConfig.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: filterExpressions.join(' AND '),
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: false, // Sort by SK descending (newest first)
      });

      const response = await this.docClient.send(command);

      logger.debug('Query completed', {
        userId,
        itemCount: response.Items?.length || 0,
        hasMore: !!response.LastEvaluatedKey,
      });

      return {
        items: (response.Items || []) as MediaItem[],
        lastEvaluatedKey: response.LastEvaluatedKey,
      };
    } catch (error) {
      logger.error('Failed to query media by user', error, { userId });
      throw new DynamoDBServiceError('Failed to query media', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }
  }

  /**
   * Get a single media item by userId and mediaId
   */
  async getMediaItem(userId: string, mediaId: string): Promise<MediaItem | null> {
    logger.debug('Getting media item', { userId, mediaId });

    try {
      const command = new GetCommand({
        TableName: dynamoDBConfig.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `MEDIA#${mediaId}`,
        },
      });

      const response = await this.docClient.send(command);

      if (!response.Item) {
        logger.debug('Media item not found', { userId, mediaId });
        return null;
      }

      return response.Item as MediaItem;
    } catch (error) {
      logger.error('Failed to get media item', error, { userId, mediaId });
      throw new DynamoDBServiceError('Failed to get media item', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        mediaId,
      });
    }
  }

  /**
   * Update media status (for complete handler)
   */
  async updateMediaStatus(
    userId: string,
    mediaId: string,
    status: MediaStatus
  ): Promise<void> {
    logger.debug('Updating media status', { userId, mediaId, status });

    try {
      const command = new UpdateCommand({
        TableName: dynamoDBConfig.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `MEDIA#${mediaId}`,
        },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(PK)',
      });

      await this.docClient.send(command);

      logger.info('Media status updated', { userId, mediaId, status });
    } catch (error) {
      logger.error('Failed to update media status', error, { userId, mediaId, status });
      throw new DynamoDBServiceError('Failed to update media status', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        mediaId,
      });
    }
  }

  /**
   * Update media filename (for rename handler - DynamoDB only, no S3 changes)
   */
  async updateMediaFilename(
    userId: string,
    mediaId: string,
    filename: string
  ): Promise<void> {
    logger.debug('Updating media filename', { userId, mediaId, filename });

    try {
      const command = new UpdateCommand({
        TableName: dynamoDBConfig.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `MEDIA#${mediaId}`,
        },
        UpdateExpression: 'SET filename = :filename, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':filename': filename,
          ':updatedAt': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(PK)',
      });

      await this.docClient.send(command);

      logger.info('Media filename updated', { userId, mediaId, filename });
    } catch (error) {
      logger.error('Failed to update media filename', error, { userId, mediaId });
      throw new DynamoDBServiceError('Failed to update media filename', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        mediaId,
      });
    }
  }

  /**
   * Delete a single media record
   */
  async deleteMediaRecord(userId: string, mediaId: string): Promise<void> {
    logger.debug('Deleting media record', { userId, mediaId });

    try {
      const command = new DeleteCommand({
        TableName: dynamoDBConfig.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `MEDIA#${mediaId}`,
        },
      });

      await this.docClient.send(command);

      logger.info('Media record deleted', { userId, mediaId });
    } catch (error) {
      logger.error('Failed to delete media record', error, { userId, mediaId });
      throw new DynamoDBServiceError('Failed to delete media record', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        mediaId,
      });
    }
  }

  /**
   * Delete multiple media records in batch
   */
  async deleteMediaRecords(userId: string, mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) {
      return;
    }

    logger.debug('Deleting media records in batch', { userId, count: mediaIds.length });

    try {
      // Split into batches of 25 (DynamoDB limit)
      const batches: string[][] = [];
      for (let i = 0; i < mediaIds.length; i += MAX_BATCH_WRITE_ITEMS) {
        batches.push(mediaIds.slice(i, i + MAX_BATCH_WRITE_ITEMS));
      }

      for (const batch of batches) {
        const params: BatchWriteCommandInput = {
          RequestItems: {
            [dynamoDBConfig.tableName]: batch.map((mediaId) => ({
              DeleteRequest: {
                Key: {
                  PK: `USER#${userId}`,
                  SK: `MEDIA#${mediaId}`,
                },
              },
            })),
          },
        };

        await this.docClient.send(new BatchWriteCommand(params));
      }

      logger.info('Media records deleted', { userId, count: mediaIds.length });
    } catch (error) {
      logger.error('Failed to delete media records', error, { userId, count: mediaIds.length });
      throw new DynamoDBServiceError('Failed to delete media records', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        count: mediaIds.length,
      });
    }
  }

  /**
   * Search media by filename (contains filter)
   * Note: This uses a scan with filter, which is less efficient than a GSI query
   * For better performance at scale, consider adding a GSI on filename
   */
  async searchMediaByFilename(
    userId: string,
    query: string,
    options?: {
      mediaType?: MediaType;
      limit?: number;
    }
  ): Promise<MediaItem[]> {
    const { mediaType, limit = 50 } = options || {};
    const normalizedQuery = query.toLowerCase().trim();

    logger.debug('Searching media by filename', { userId, query: normalizedQuery, mediaType, limit });

    try {
      // Build filter expression
      const filterExpressions: string[] = [
        '#status = :status',
        'contains(#filename, :query)',
      ];
      const expressionAttributeValues: Record<string, any> = {
        ':pk': `USER#${userId}`,
        ':skPrefix': 'MEDIA#',
        ':status': 'ready',
        ':query': normalizedQuery,
      };
      const expressionAttributeNames: Record<string, string> = {
        '#status': 'status',
        '#filename': 'filename',
      };

      if (mediaType) {
        filterExpressions.push('mediaType = :mediaType');
        expressionAttributeValues[':mediaType'] = mediaType;
      }

      const command = new QueryCommand({
        TableName: dynamoDBConfig.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: filterExpressions.join(' AND '),
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: expressionAttributeNames,
        Limit: limit * 3, // Over-fetch since we're filtering client-side
      });

      const response = await this.docClient.send(command);

      // Take only the requested limit
      const items = (response.Items || []).slice(0, limit) as MediaItem[];

      logger.debug('Search completed', {
        userId,
        query: normalizedQuery,
        resultCount: items.length,
      });

      return items;
    } catch (error) {
      logger.error('Failed to search media', error, { userId, query });
      throw new DynamoDBServiceError('Failed to search media', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        query,
      });
    }
  }
}

// Export singleton instance
export const dynamoDBService = new DynamoDBService();
