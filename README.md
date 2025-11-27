# QuickCut Media Upload Backend

AWS Lambda backend for handling multipart media uploads to S3 with presigned URLs.

## Features

- Multipart uploads supporting files up to 5GB
- Media management: list, search, delete, and rename
- Automatic thumbnail handling for videos
- Media type organization (videos/images/audios)
- Batch deletion (up to 100 files)
- Input sanitization and path traversal prevention

## Project Structure

```
src/
├── handlers/
│   ├── router.handler.ts       # Routes requests to handlers
│   ├── upload.handler.ts       # POST /upload/initiate
│   ├── complete.handler.ts     # POST /upload/complete
│   ├── list-media.handler.ts   # GET /media
│   ├── search-media.handler.ts # GET /media/search
│   ├── delete-media.handler.ts # DELETE /media
│   └── rename-media.handler.ts # PATCH /media/rename
├── services/
│   ├── s3.service.ts           # S3 operations
│   └── validation.service.ts   # Input validation
├── utils/
│   ├── auth.ts                 # Authentication context extraction
│   ├── logger.ts               # Structured logging
│   └── sanitize.ts             # Input sanitization
├── errors/
│   └── AppError.ts             # Custom error classes
├── types/
│   └── index.ts                # TypeScript interfaces
└── config/
    └── index.ts                # Environment configuration
```

## Authentication

All endpoints require authentication via API Gateway Lambda authorizer. The authorizer validates the `qc_session` HTTP-only cookie and passes the authenticated user ID to Lambda functions.

- Client requests must include `credentials: 'include'`
- User ID is extracted from the validated session, not from request bodies
- All file operations are scoped to the authenticated user

## API Endpoints

### POST /upload/initiate

Initiates multipart upload for one or more files. Each file can optionally include a thumbnail (for videos).

**Request**: JSON body with `files` array containing objects with `main` (required) and `thumbnail` (optional) properties. Each file object includes `filename`, `fileType`, and `fileSize`.

**Response**: Upload configurations with presigned URLs for each part, file IDs, and S3 keys.

### POST /upload/complete

Completes a multipart upload after all parts have been uploaded.

**Request**: `fileId`, `s3Key`, `uploadId`, and `parts` array with `partNumber` and `etag` for each uploaded part.

**Response**: Completed upload metadata including file location.

### GET /media

Lists user's media files with optional filtering and pagination.

**Query Parameters**:
- `mediaType`: Filter by `visual` (videos + images), `videos`, `images`, or `audios`
- `limit`: Results per page (default: 50, max: 1000)
- `continuationToken`: Pagination token

**Response**: Array of files with presigned URLs. Videos include `thumbnailUrl` if thumbnail exists.

### GET /media/search

Searches media files by partial filename match (case-insensitive).

**Query Parameters**:
- `query` (required): Search string
- `mediaType`: Filter type
- `limit`: Results per page
- `continuationToken`: Pagination token

**Response**: Matching files sorted by upload date (most recent first).

### DELETE /media

Deletes one or more media files. Automatically deletes associated thumbnails for videos.

**Request**: `fileKeys` array (max 100 files).

**Response**: Success/failure status for each file. Supports partial success.

### PATCH /media/rename

Renames a media file. File extension cannot be changed.

**Request**: `fileKey` and `newFilename`.

**Response**: New file key and presigned URLs. Returns 409 if target filename already exists.

## S3 Key Structure

Files are organized with the following structure:

```
{userId}/
├── videos/{fileId}/{filename}
├── images/{fileId}/{filename}
├── audios/{fileId}/{filename}
└── thumbnails/{fileId}/thumbnail.jpg
```

Thumbnails are stored in a separate `thumbnails` directory, referenced by the same `fileId` as their parent video.

## Validation Rules

### Files
- Max 10 files per upload request
- File size: 1 byte to 5GB (configurable)
- Filename max length: 255 characters
- Must have file extension
- Cannot start with dot

### Filename Security

**Blocked**:
- Path traversal patterns: `../`, `..\\`, URL-encoded variants
- Dangerous characters: `<>:"|?*`, control characters, backslashes
- Dangerous extensions: `.exe`, `.bat`, `.sh`, `.php`, `.html`, and others

**Allowed**:
- Alphanumeric characters, dashes, underscores, spaces, dots
- Forward slashes for subdirectories

### Allowed MIME Types (Default)

- **Images**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- **Videos**: `video/mp4`, `video/quicktime`, `video/x-msvideo`
- **Audio**: `audio/mpeg`, `audio/wav`

## Environment Variables

### Required
- `S3_BUCKET_NAME`: S3 bucket for uploads

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `AWS_REGION` | `us-east-1` | AWS region |
| `S3_PART_SIZE` | `10485760` (10MB) | Multipart upload part size |
| `PRESIGNED_URL_EXPIRY` | `3600` (1 hour) | Presigned URL expiry in seconds |
| `MAX_FILE_SIZE` | `5368709120` (5GB) | Maximum file size |
| `MIN_FILE_SIZE` | `1` | Minimum file size |
| `MAX_FILES_PER_REQUEST` | `10` | Max files per upload request |
| `MAX_FILENAME_LENGTH` | `255` | Max filename length |
| `ALLOWED_MIME_TYPES` | See above | Comma-separated MIME types |
| `LOG_LEVEL` | `info` | Logging level: debug, info, warn, error |
| `CORS_ORIGIN` | `*` | CORS allowed origin |

## Error Handling

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Validation error |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not found |
| 405 | Method not allowed |
| 409 | Conflict (file already exists) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Error Codes

- `INVALID_REQUEST`, `INVALID_FILE_TYPE`, `FILE_TOO_LARGE`, `FILE_TOO_SMALL`
- `TOO_MANY_FILES`, `INVALID_FILENAME`, `MISSING_REQUIRED_FIELD`
- `INVALID_FILE_ID`, `INVALID_UPLOAD_ID`, `INVALID_PARTS`
- `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`
- `RATE_LIMIT_EXCEEDED`, `S3_SERVICE_ERROR`, `INTERNAL_SERVER_ERROR`

## Build and Deploy

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run package      # Build and create function.zip
npm run deploy       # Deploy to Lambda
```

**Lambda Configuration**:
- Handler: `dist/index.handler`
- Runtime: Node.js 22.x

## Development

```bash
npm test             # Run tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
npm run lint         # ESLint check
npm run lint:fix     # Auto-fix linting
```

## IAM Permissions Required

The Lambda execution role needs:
- `s3:CreateMultipartUpload`, `s3:AbortMultipartUpload`, `s3:CompleteMultipartUpload`
- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:CopyObject`
- `s3:ListBucket`, `s3:HeadObject`, `s3:ListMultipartUploadParts`
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`

## Tech Stack

- **Runtime**: Node.js 22.x, TypeScript
- **Cloud**: AWS Lambda, S3, API Gateway
- **Dependencies**: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, uuid
