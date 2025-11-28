# CloudWatch Logs Insights Guide

This guide explains how to use CloudWatch Logs Insights to debug the QuickCut Media Backend Lambda functions.

## Log Group

All logs are written to:
```
/aws/lambda/quickcut-data-handler-dev
```

## Log Structure

Every log entry includes:
- `timestamp` - ISO 8601 timestamp
- `level` - Log level (error, warn, info, debug)
- `message` - Human-readable message
- `requestId` - Unique ID for tracking a single request
- `userId` - Authenticated user ID
- `action` - Handler action (media-upload, complete-upload, list-media, search-media, delete-media, rename-media)

## Common Queries

### Track a Single Request

Find all logs for a specific request by requestId:

```sql
fields @timestamp, level, message
| filter requestId = "your-request-id-here"
| sort @timestamp asc
```

### Find All Errors

```sql
fields @timestamp, level, message, requestId, userId, action
| filter level = "error"
| sort @timestamp desc
| limit 100
```

### Find Errors by Action

```sql
fields @timestamp, message, requestId, userId
| filter level = "error" and action = "delete-media"
| sort @timestamp desc
| limit 50
```

### Find Slow Operations

Operations taking longer than 1 second:

```sql
fields @timestamp, operation, durationMs, requestId
| filter durationMs > 1000
| sort durationMs desc
| limit 50
```

### Find Slow DynamoDB Queries

```sql
fields @timestamp, operation, durationMs, userId
| filter operation in ["getMediaByUser", "getMediaItem", "searchMediaByFilename"]
| filter durationMs > 500
| sort durationMs desc
```

### Find Slow S3 Operations

```sql
fields @timestamp, operation, durationMs, s3Key, bucket
| filter operation in ["generatePresignedGetUrl", "generateLowresPresignedGetUrl", "deleteObject", "deleteLowresObject"]
| filter durationMs > 200
| sort durationMs desc
```

## Handler-Specific Queries

### Upload Handler

Track upload flow:
```sql
fields @timestamp, message, fileCount
| filter action = "media-upload"
| filter message like /Step/
| sort @timestamp asc
```

Find upload failures:
```sql
fields @timestamp, message, requestId, userId
| filter action = "media-upload" and level = "error"
| sort @timestamp desc
```

### Complete Handler

Track complete upload flow:
```sql
fields @timestamp, message, fileId
| filter action = "complete-upload"
| filter message like /Step/
| sort @timestamp asc
```

### List Media Handler

Track list operations:
```sql
fields @timestamp, message, fileCount, hasMore
| filter action = "list-media"
| filter message like /Step/
| sort @timestamp asc
```

### Search Media Handler

Track search operations:
```sql
fields @timestamp, message, query, matchCount
| filter action = "search-media"
| filter message like /Step/
| sort @timestamp asc
```

### Delete Media Handler

Track delete operations step-by-step:
```sql
fields @timestamp, message, mediaId, step
| filter action = "delete-media"
| sort @timestamp asc
```

Find failed deletes:
```sql
fields @timestamp, message, mediaId, error
| filter action = "delete-media"
| filter level in ["error", "warn"]
| sort @timestamp desc
```

### Rename Media Handler

Track rename operations:
```sql
fields @timestamp, message, mediaId, newFilename
| filter action = "rename-media"
| filter message like /Step/
| sort @timestamp asc
```

## Validation Failures

Find all validation failures:
```sql
fields @timestamp, validationType, errors, requestId
| filter message like /Validation failed/
| sort @timestamp desc
| limit 50
```

Find specific validation type failures:
```sql
fields @timestamp, validationType, field, reason, errors
| filter message like /Validation failed/
| filter validationType = "files"
| sort @timestamp desc
```

## DynamoDB Operations

Track DynamoDB query performance:
```sql
fields @timestamp, operation, durationMs, itemCount, scannedCount
| filter message like /DynamoDB query completed/
| sort @timestamp desc
```

Find DynamoDB errors:
```sql
fields @timestamp, message, userId, mediaId, operation
| filter level = "error"
| filter message like /DynamoDB/
| sort @timestamp desc
```

## S3 Operations

Track presigned URL generation:
```sql
fields @timestamp, operation, s3Key, bucket, durationMs
| filter operation in ["generatePresignedGetUrl", "generateLowresPresignedGetUrl"]
| sort @timestamp desc
```

Track S3 deletions:
```sql
fields @timestamp, message, s3Key, bucket
| filter message like /deleted from/
| sort @timestamp desc
```

## User Activity

Find all requests for a specific user:
```sql
fields @timestamp, action, message, requestId
| filter userId = "user_abc123"
| sort @timestamp desc
| limit 100
```

Count requests per user:
```sql
stats count(*) as requestCount by userId
| filter message like /request received/
| sort requestCount desc
| limit 20
```

## Error Analysis

Count errors by type:
```sql
stats count(*) as errorCount by message
| filter level = "error"
| sort errorCount desc
```

Count errors by action:
```sql
stats count(*) as errorCount by action
| filter level = "error"
| sort errorCount desc
```

## Performance Dashboard Queries

Average operation duration by type:
```sql
stats avg(durationMs) as avgDuration, max(durationMs) as maxDuration, count(*) as count by operation
| filter durationMs > 0
| sort avgDuration desc
```

Request count by action over time:
```sql
stats count(*) as requests by bin(5m), action
| filter message like /request received/
```

## Tips

1. **Set time range**: Always set an appropriate time range in the CloudWatch console to limit results.

2. **Use requestId for debugging**: Every request has a unique requestId. Use it to trace a single request through all its steps.

3. **Check step-by-step logs**: Each handler logs numbered steps (Step 1, Step 2, etc.). Filter by `message like /Step/` to see the flow.

4. **Debug level logs**: Operation timing and detailed DynamoDB/S3 parameters are logged at debug level. Ensure LOG_LEVEL environment variable includes debug if needed.

5. **Export results**: CloudWatch Logs Insights allows exporting query results to CSV for further analysis.
