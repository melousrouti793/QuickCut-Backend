# QuickCut Media Upload Backend

AWS Lambda backend for handling multipart media uploads to S3 via presigned URLs.

## Quick Start

```bash
# Install and build
npm install
npm run build

# Deploy to Lambda
npm run package
npm run deploy
```

## How It Works

### Request Flow

1. Client sends POST request to `/upload/initiate` or `/upload/complete`
2. API Gateway routes request to Lambda (includes stage prefix like `/dev/`)
3. Router handler strips stage prefix and routes to appropriate handler
4. Handler validates request and processes upload
5. Response returned to client

### Code Structure

```
src/
├── handlers/
│   ├── router.handler.ts       # Main entry point - routes requests
│   ├── upload.handler.ts       # Handles /upload/initiate
│   └── complete.handler.ts     # Handles /upload/complete
│
├── services/
│   ├── validation.service.ts   # Input validation
│   └── s3.service.ts           # S3 multipart operations
│
├── types/
│   └── index.ts                # TypeScript interfaces
│
├── errors/
│   └── AppError.ts             # Custom error classes
│
├── utils/
│   └── logger.ts               # Structured logging
│
└── config/
    └── index.ts                # Environment configuration
```

## Lambda Handler Configuration

- **Handler**: `dist/index.handler`
- **Runtime**: Node.js 22.x
- **Entry point**: `src/handlers/router.handler.ts`

The handler processes requests through this chain:
1. `router.handler.ts` - Strips stage prefix, routes by path
2. `upload.handler.ts` or `complete.handler.ts` - Processes specific endpoint
3. Services validate and execute business logic
4. Response built and returned

## API Endpoints

### POST /upload/initiate

**Request Body:**
```json
{
  "userId": "user123",
  "files": [
    {
      "filename": "video.mp4",
      "fileType": "video/mp4",
      "fileSize": 157286400
    }
  ]
}
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Upload URLs generated successfully",
  "data": {
    "uploads": [
      {
        "fileId": "550e8400-e29b-41d4-a716-446655440000",
        "s3Key": "uploads/user123/2024/01/15/.../video.mp4",
        "uploadId": "...",
        "parts": [
          { "partNumber": 1, "url": "https://..." }
        ],
        "expiresAt": "2024-01-15T16:30:00.000Z"
      }
    ]
  }
}
```

### POST /upload/complete

**Request Body:**
```json
{
  "userId": "user123",
  "fileId": "550e8400-e29b-41d4-a716-446655440000",
  "s3Key": "uploads/user123/.../video.mp4",
  "uploadId": "...",
  "parts": [
    { "partNumber": 1, "etag": "d41d8cd98f00b204e9800998ecf8427e" }
  ]
}
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Upload completed successfully",
  "data": {
    "fileId": "550e8400-e29b-41d4-a716-446655440000",
    "bucket": "my-bucket",
    "s3Key": "uploads/user123/.../video.mp4",
    "location": "https://...",
    "metadata": {
      "filename": "video.mp4",
      "fileType": "video/mp4",
      "uploadedAt": "2024-01-15T15:30:00.000Z"
    }
  }
}
```

## Request Processing Details

### Router Handler ([router.handler.ts](src/handlers/router.handler.ts))

Strips API Gateway stage prefix and routes requests:

```typescript
const rawPath = event.rawPath;  // e.g., "/dev/upload/initiate"
const path = rawPath.replace(/^\/[^/]+/, '');  // "/upload/initiate"

switch (path) {
  case '/upload/initiate':
    return await initiateHandler(event);
  case '/upload/complete':
    return await completeHandler(event);
}
```

### Upload Handler ([upload.handler.ts](src/handlers/upload.handler.ts))

Processes initiate requests:

1. Parse request body
2. Validate userId (temporary - MVP approach)
3. Validate files (type, size, filename)
4. Create S3 multipart uploads
5. Generate presigned URLs
6. Return upload configurations

### Complete Handler ([complete.handler.ts](src/handlers/complete.handler.ts))

Processes completion requests:

1. Parse request body
2. Validate userId
3. Validate completion data (fileId, uploadId, parts)
4. Complete S3 multipart upload
5. Return final file location

## Validation Rules

### Files ([validation.service.ts:58](src/services/validation.service.ts#L58))

- Max 10 files per request
- File size: 1 byte to 5GB
- Allowed MIME types: image/jpeg, image/png, video/mp4, etc.
- Filename max length: 255 characters
- No path traversal patterns

### UserId ([validation.service.ts:17](src/services/validation.service.ts#L17))

- Alphanumeric, dashes, underscores only
- Max 128 characters
- Cannot be empty

### Parts ([validation.service.ts:322](src/services/validation.service.ts#L322))

- Must be sequential (1, 2, 3...)
- No duplicate part numbers
- Valid ETag format
- Part numbers 1-10000

## Error Handling

All errors return this format:

```json
{
  "statusCode": 400,
  "errorCode": "INVALID_REQUEST",
  "message": "File validation failed",
  "details": {
    "validationErrors": ["..."]
  },
  "requestId": "req-123-456"
}
```

### Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `INVALID_REQUEST` | 400 | Validation error |
| `INVALID_FILE_TYPE` | 400 | File type not allowed |
| `FILE_TOO_LARGE` | 400 | Exceeds size limit |
| `TOO_MANY_FILES` | 400 | Too many files |
| `MISSING_REQUIRED_FIELD` | 400 | Required field missing |
| `METHOD_NOT_ALLOWED` | 405 | Only POST allowed |
| `NOT_FOUND` | 404 | Route not found |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected error |
| `S3_SERVICE_ERROR` | 500 | S3 operation failed |

## Environment Variables

### Required

- `S3_BUCKET_NAME` - S3 bucket for uploads

### Optional (with defaults)

- `AWS_REGION` - AWS region (default: us-east-1)
- `S3_KEY_PREFIX` - Prefix for S3 keys (default: uploads)
- `S3_PART_SIZE` - Part size in bytes (default: 5MB)
- `PRESIGNED_URL_EXPIRY` - URL expiry in seconds (default: 3600)
- `MAX_FILE_SIZE` - Max file size in bytes (default: 5GB)
- `MAX_FILES_PER_REQUEST` - Max files (default: 10)
- `ALLOWED_MIME_TYPES` - Comma-separated MIME types
- `LOG_LEVEL` - Logging level (default: info)

## Build and Deploy

```bash
# Build TypeScript to dist/
npm run build

# Package dist/ and node_modules into function.zip
npm run package

# Deploy to Lambda
npm run deploy
```

The build process compiles TypeScript files from `src/` to JavaScript in `dist/`. The Lambda handler must be configured as `dist/index.handler` to find the compiled entry point.

## TypeScript Types

Key interfaces are defined in [src/types/index.ts](src/types/index.ts):

- `UploadRequest` - Initiate request body
- `CompleteUploadRequest` - Complete request body
- `MediaFile` - File metadata
- `UploadConfiguration` - Initiate response
- `CompletedUpload` - Complete response
- `ErrorResponse` - Error format

## Logging

All handlers use structured logging with context:

```typescript
logger.setContext({ requestId, userId, action: 'media-upload' });
logger.info('Upload request received', { fileCount: 5 });
logger.error('Upload failed', error);
logger.clearContext();
```

Logs include:
- Request ID for tracing
- User ID
- Action being performed
- File metadata
- Error details

## Security Notes

**Authentication**: Currently accepts `userId` in request body for MVP testing. This is temporary and should be replaced with API Gateway authorizer for production.

**Validation**: All inputs are validated for:
- File types (whitelist)
- File sizes (min/max)
- Filename safety (no path traversal)
- Request structure

**S3 Security**:
- Presigned URLs expire after 1 hour
- Server-side encryption enabled
- Unique file paths per user

## NPM Scripts

- `npm run build` - Compile TypeScript
- `npm test` - Run tests
- `npm run lint` - Check code style
- `npm run package` - Create deployment zip
- `npm run deploy` - Update Lambda function

## IAM Permissions Required

Lambda execution role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateMultipartUpload",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
        "s3:CompleteMultipartUpload",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
```
