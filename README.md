# QuickCut Media Upload Backend

AWS Lambda backend for handling multipart media uploads to S3 via presigned URLs with comprehensive media management features.

## Features

- **Multipart Upload**: Large file uploads (up to 5GB) with presigned URLs
- **Media Management**: List, search, delete, and rename media files
- **Thumbnail Support**: Automatic thumbnail handling for visual media
- **Security**: Input sanitization, path traversal prevention, XSS protection
- **Media Type Separation**: Automatic organization by visual/audio types
- **Batch Operations**: Delete multiple files in one request

## Quick Start

```bash
# Install and build
npm install
npm run build

# Deploy to Lambda
npm run package
npm run deploy
```

## Architecture

### Request Flow

1. Client sends request to API Gateway endpoint (e.g., `/dev/media`)
2. API Gateway routes request to Lambda with stage prefix
3. Router handler strips stage prefix and routes to appropriate handler
4. Handler validates request and processes operation
5. Response returned to client with proper CORS headers

### Code Structure

```
src/
├── handlers/
│   ├── router.handler.ts       # Main entry point - routes all requests
│   ├── upload.handler.ts       # POST /upload/initiate
│   ├── complete.handler.ts     # POST /upload/complete
│   ├── list-media.handler.ts   # GET /media
│   ├── search-media.handler.ts # GET /media/search
│   ├── delete-media.handler.ts # DELETE /media
│   └── rename-media.handler.ts # PATCH /media/rename
│
├── services/
│   ├── validation.service.ts   # Input validation
│   └── s3.service.ts           # S3 operations (upload, list, delete, rename)
│
├── types/
│   └── index.ts                # TypeScript interfaces
│
├── errors/
│   └── AppError.ts             # Custom error classes
│
├── utils/
│   ├── auth.ts                 # Authentication & authorizer context extraction
│   ├── logger.ts               # Structured logging
│   └── sanitize.ts             # Input sanitization utilities
│
└── config/
    └── index.ts                # Environment configuration
```

## Authentication

All endpoints require authentication via HTTP-only cookie. The API Gateway Lambda authorizer validates the `qc_session` cookie before each request and passes the authenticated user's ID to the Lambda function.

**Important:**
- Client requests must include `credentials: 'include'` to send cookies
- The `userId` is automatically extracted from the session
- Clients **cannot** specify their own `userId` in requests
- All file operations are scoped to the authenticated user

## API Endpoints

### POST /upload/initiate

Initiate a multipart upload for one or more files.

**Request Body:**
```json
{
  "files": [
    {
      "filename": "video.mp4",
      "fileType": "video/mp4",
      "fileSize": 157286400
    },
    {
      "filename": "thumbnail/video.jpg",
      "fileType": "image/jpeg",
      "fileSize": 45000
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
        "s3Key": "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
        "bucket": "my-bucket",
        "uploadId": "...",
        "parts": [
          { "partNumber": 1, "url": "https://presigned-url-1..." },
          { "partNumber": 2, "url": "https://presigned-url-2..." }
        ],
        "filename": "video.mp4",
        "fileType": "video/mp4",
        "expiresAt": "2025-11-19T16:30:00.000Z"
      }
    ],
    "totalFiles": 2
  }
}
```

**Notes:**
- Supports subdirectory paths like `thumbnail/video.jpg` for thumbnail uploads
- Files are automatically organized by media type (visual/audio) and date
- Presigned URLs expire after 1 hour

### POST /upload/complete

Complete a multipart upload after all parts are uploaded.

**Request Body:**
```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440000",
  "s3Key": "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
  "uploadId": "...",
  "parts": [
    { "partNumber": 1, "etag": "d41d8cd98f00b204e9800998ecf8427e" },
    { "partNumber": 2, "etag": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" }
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
    "s3Key": "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
    "location": "https://s3.amazonaws.com/...",
    "metadata": {
      "filename": "video.mp4",
      "fileType": "video/mp4",
      "uploadedAt": "2025-11-19T15:30:00.000Z"
    }
  }
}
```

### GET /media

List user's media files with optional filtering and pagination.

**Query Parameters:**
- `mediaType` (optional): Filter by `visual` or `audio`
- `limit` (optional): Results per page (default: 50, max: 1000)
- `continuationToken` (optional): Pagination token

**Example:**
```
GET /media?mediaType=visual&limit=20
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Media files retrieved successfully",
  "data": {
    "files": [
      {
        "fileKey": "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
        "filename": "video.mp4",
        "mediaType": "visual",
        "size": 157286400,
        "uploadedAt": "2025-11-19T15:30:00.000Z",
        "url": "https://presigned-url...",
        "thumbnailUrl": "https://presigned-thumbnail-url..."
      }
    ],
    "count": 1,
    "hasMore": false,
    "nextToken": null
  }
}
```

**Notes:**
- URLs are presigned and expire after 1 hour
- Thumbnail files are automatically filtered out from results
- `thumbnailUrl` is present for visual media, `null` for audio

### GET /media/search

Search media files by partial filename match.

**Query Parameters:**
- `query` (required): Search query (partial filename)
- `mediaType` (optional): Filter by `visual` or `audio`
- `limit` (optional): Results per page (default: 50, max: 1000)
- `continuationToken` (optional): Pagination token

**Example:**
```
GET /media/search?query=vacation&mediaType=visual
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Search completed successfully",
  "data": {
    "query": "vacation",
    "mediaType": "visual",
    "files": [
      {
        "fileKey": "uploads/user123/visual/2025/11/19/abc-123/vacation.mp4",
        "filename": "vacation.mp4",
        "mediaType": "visual",
        "size": 157286400,
        "uploadedAt": "2025-11-19T15:30:00.000Z",
        "url": "https://presigned-url...",
        "thumbnailUrl": "https://presigned-thumbnail-url..."
      }
    ],
    "count": 1,
    "hasMore": false,
    "nextToken": null
  }
}
```

**Notes:**
- Search is case-insensitive
- Matches any filename containing the query string
- When `mediaType` is omitted, searches both visual and audio files

### DELETE /media

Delete one or more media files.

**Request Body:**
```json
{
  "fileKeys": [
    "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
    "uploads/user123/audio/2025/11/19/xyz-456/song.mp3"
  ]
}
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Files deleted successfully",
  "data": {
    "deleted": [
      "uploads/user123/visual/2025/11/19/abc-123/video.mp4",
      "uploads/user123/audio/2025/11/19/xyz-456/song.mp3"
    ],
    "failed": [],
    "totalRequested": 2,
    "successCount": 2,
    "failureCount": 0
  }
}
```

**Notes:**
- Supports batch deletion (up to 100 files)
- Automatically deletes thumbnails for visual media
- Users can only delete their own files
- Returns partial success if some deletions fail

### PATCH /media/rename

Rename a media file.

**Request Body:**
```json
{
  "fileKey": "uploads/user123/visual/2025/11/19/abc-123/old-name.mp4",
  "newFilename": "new-name.mp4"
}
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "File renamed successfully",
  "data": {
    "oldKey": "uploads/user123/visual/2025/11/19/abc-123/old-name.mp4",
    "newKey": "uploads/user123/visual/2025/11/19/abc-123/new-name.mp4",
    "filename": "new-name.mp4",
    "url": "https://presigned-url-to-new-file...",
    "thumbnailUrl": "https://presigned-thumbnail-url..."
  }
}
```

**Notes:**
- File extension cannot be changed
- Automatically renames thumbnails for visual media
- Users can only rename their own files
- Returns 409 if a file with the new name already exists

## S3 Key Structure

Files are organized in S3 with the following structure:

```
uploads/
└── {userId}/
    ├── visual/
    │   └── {year}/
    │       └── {month}/
    │           └── {day}/
    │               └── {fileId}/
    │                   ├── video.mp4              # Original file
    │                   └── thumbnail/
    │                       └── video.jpg          # Thumbnail
    └── audio/
        └── {year}/
            └── {month}/
                └── {day}/
                    └── {fileId}/
                        └── song.mp3               # Original file (no thumbnail)
```

**Example:**
```
uploads/user123/visual/2025/11/19/abc-123-def-456/video.mp4
uploads/user123/visual/2025/11/19/abc-123-def-456/thumbnail/video.jpg
uploads/user123/audio/2025/11/19/xyz-789-ghi-012/song.mp3
```

## Thumbnail Support

### Overview

- **Required for**: All visual media (videos and images)
- **Not required for**: Audio files
- **Location**: `/thumbnail/` subdirectory within each file's folder
- **Format**: Always JPEG (`.jpg`)

### Uploading Thumbnails

When uploading visual media, upload the thumbnail as a separate file:

```json
{
  "files": [
    {
      "filename": "video.mp4",
      "fileType": "video/mp4",
      "fileSize": 157286400
    },
    {
      "filename": "thumbnail/video.jpg",
      "fileType": "image/jpeg",
      "fileSize": 45000
    }
  ]
}
```

The backend will automatically place the thumbnail in the correct subdirectory.

### Automatic Thumbnail Handling

All media operations automatically handle thumbnails:

- **List/Search**: Returns `thumbnailUrl` for visual media (null for audio)
- **Delete**: Automatically deletes thumbnails when deleting visual media
- **Rename**: Automatically renames thumbnails when renaming visual media
- **Filter**: Thumbnails are automatically filtered from list/search results

## Validation Rules

### Files

- Max 10 files per request
- File size: 1 byte to 5GB (default)
- Filename max length: 255 characters
- Allowed characters: alphanumeric, dash, underscore, space, dot, forward slash
- No path traversal patterns (`../`, `..\\`, etc.)
- Cannot start with dot (hidden files)
- Must have file extension

### Filename Security

The system blocks:
- Path traversal: `../`, `..\\`, `..%2F`, `..%5C`, etc.
- Backslashes: `\`
- Dangerous characters: `<`, `>`, `:`, `"`, `|`, `?`, `*`, control characters
- Dangerous extensions: `.exe`, `.bat`, `.sh`, `.php`, `.html`, etc.

The system allows:
- Forward slashes for subdirectories: `thumbnail/video.jpg`
- Multiple consecutive dots: `file...mp3`
- Spaces in filenames: `My Video.mp4`

### MIME Types (Default)

**Visual:**
- `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- `video/mp4`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`

**Audio:**
- `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/aac`, `audio/ogg`

### UserId (from Authorizer)

The userId is automatically extracted from the authenticated session by the API Gateway authorizer. It must meet these format requirements:

- Alphanumeric, dashes, underscores only
- Max 128 characters
- Cannot be empty

**Note:** Clients do not send userId - it is provided by the authorizer after validating the session cookie.

### Parts (for multipart upload)

- Must be sequential (1, 2, 3...)
- No duplicate part numbers
- Valid ETag format
- Part numbers 1-10000

## Error Handling

### Error Response Format

```json
{
  "statusCode": 400,
  "errorCode": "INVALID_REQUEST",
  "message": "File validation failed",
  "details": {
    "validationErrors": ["File at index 0: filename contains invalid characters"]
  },
  "requestId": "req-123-456"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request (validation error) |
| 404 | Not Found (file or route) |
| 405 | Method Not Allowed |
| 409 | Conflict (e.g., file already exists) |
| 500 | Internal Server Error |

### Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `INVALID_REQUEST` | 400 | General validation error |
| `INVALID_FILE_TYPE` | 400 | File type not allowed |
| `FILE_TOO_LARGE` | 400 | Exceeds size limit |
| `FILE_TOO_SMALL` | 400 | Below minimum size |
| `TOO_MANY_FILES` | 400 | Too many files in request |
| `INVALID_FILENAME` | 400 | Filename validation failed |
| `MISSING_REQUIRED_FIELD` | 400 | Required field missing |
| `INVALID_FILE_ID` | 400 | Invalid UUID format |
| `INVALID_UPLOAD_ID` | 400 | Invalid S3 upload ID |
| `INVALID_PARTS` | 400 | Parts array validation failed |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict (duplicate) |
| `METHOD_NOT_ALLOWED` | 405 | HTTP method not allowed |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected error |
| `S3_SERVICE_ERROR` | 500 | S3 operation failed |

## Environment Variables

### Required

- `S3_BUCKET_NAME` - S3 bucket for uploads

### Optional (with defaults)

- `AWS_REGION` - AWS region (default: `us-east-1`)
- `S3_KEY_PREFIX` - Prefix for S3 keys (default: `uploads`)
- `S3_PART_SIZE` - Part size in bytes (default: `10485760` = 10MB)
- `PRESIGNED_URL_EXPIRY` - URL expiry in seconds (default: `3600` = 1 hour)
- `MAX_FILE_SIZE` - Max file size in bytes (default: `5368709120` = 5GB)
- `MIN_FILE_SIZE` - Min file size in bytes (default: `1`)
- `MAX_FILES_PER_REQUEST` - Max files (default: `10`)
- `MAX_FILENAME_LENGTH` - Max filename length (default: `255`)
- `ALLOWED_MIME_TYPES` - Comma-separated MIME types
- `LOG_LEVEL` - Logging level: `debug`, `info`, `warn`, `error` (default: `info`)

## Build and Deploy

```bash
# Build TypeScript to dist/
npm run build

# Package dist/ and node_modules into function.zip
npm run package

# Deploy to Lambda
npm run deploy

# Or do all at once
npm run package && npm run deploy
```

The build process:
1. Compiles TypeScript files from `src/` to JavaScript in `dist/`
2. Creates `function.zip` containing `dist/` and `node_modules/`
3. Uploads zip to Lambda function `quickcut-data-handler-dev`

**Lambda Configuration:**
- Handler: `dist/index.handler`
- Runtime: Node.js 22.x
- Entry point: `src/index.ts` → `dist/index.js`

## TypeScript Types

Key interfaces defined in [src/types/index.ts](src/types/index.ts):

### Request Types
- `UploadRequest` - Initiate upload request
- `CompleteUploadRequest` - Complete upload request
- `ListMediaQueryParams` - List media query params
- `SearchMediaQueryParams` - Search media query params
- `DeleteMediaRequest` - Delete media request
- `RenameMediaRequest` - Rename media request
- `MediaFile` - File metadata

### Response Types
- `SuccessResponse` - Initiate upload response
- `CompleteSuccessResponse` - Complete upload response
- `ListMediaSuccessResponse` - List media response
- `SearchMediaSuccessResponse` - Search media response
- `DeleteMediaSuccessResponse` - Delete media response
- `RenameMediaSuccessResponse` - Rename media response
- `ErrorResponse` - Error response format

### Data Types
- `MediaFileInfo` - Media file information (includes `thumbnailUrl`)
- `UploadConfiguration` - Upload config with presigned URLs
- `CompletedUpload` - Completed upload metadata
- `DeleteResult` - Individual delete result
- `RenameMediaData` - Rename operation result

## Logging

All handlers use structured logging with context:

```typescript
logger.setContext({ requestId, userId, action: 'list-media' });
logger.info('List media request received', {
  mediaType: 'visual',
  limit: 50
});
logger.error('List media failed', error);
logger.clearContext();
```

**Log Levels:**
- `debug` - Detailed debugging information
- `info` - General information (default)
- `warn` - Warning messages
- `error` - Error messages

**Log Context Includes:**
- Request ID (for tracing)
- User ID
- Action being performed
- File metadata
- Error details with stack traces

## Security

### Authentication

All endpoints require authentication via API Gateway Lambda authorizer:

- **Session Validation**: Validates the `qc_session` HTTP-only cookie before each request
- **Automatic User ID Extraction**: The authenticated user's ID is automatically extracted from the session
- **Request Context**: User information is passed to Lambda via `event.requestContext.authorizer`
- **Client Requirements**: Requests must include `credentials: 'include'` to send cookies
- **Security**: Clients cannot specify or impersonate other users - the userId comes only from the validated session

### Input Validation

All inputs are validated for:
- **File types**: MIME type whitelist
- **File sizes**: Min/max limits
- **Filenames**: Sanitization and security checks
- **Path traversal**: Blocked (`../`, `..\\`, encoded variants)
- **XSS prevention**: HTML tag removal, control character filtering
- **Request structure**: Required fields, data types
- **Authorization**: Users can only access their own files

### S3 Security

- **Presigned URLs**: Expire after 1 hour
- **Server-side encryption**: AES256 enabled
- **Unique paths**: Files organized by userId and fileId
- **Access control**: Users isolated to their own prefix
- **Metadata**: Stored with each object for tracking

### File Key Authorization

Every operation validates that:
- User can only access files under `uploads/{userId}/`
- File keys match expected format
- No path traversal in keys

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
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:CopyObject",
        "s3:ListBucket",
        "s3:HeadObject"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET_NAME",
        "arn:aws:s3:::YOUR_BUCKET_NAME/*"
      ]
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

## NPM Scripts

- `npm run build` - Compile TypeScript to `dist/`
- `npm test` - Run tests with Jest
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Generate coverage report
- `npm run lint` - Check code style with ESLint
- `npm run lint:fix` - Auto-fix linting issues
- `npm run package` - Build and create `function.zip`
- `npm run deploy` - Upload `function.zip` to Lambda

## Development

### Local Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Lint code
npm run lint
```

### Project Structure

- **Handlers**: Entry points for each API endpoint
- **Services**: Business logic (validation, S3 operations)
- **Utils**: Shared utilities (logging, sanitization)
- **Types**: TypeScript interfaces and types
- **Errors**: Custom error classes
- **Config**: Environment configuration

### Adding New Endpoints

1. Create handler in `src/handlers/`
2. Add route in `src/handlers/router.handler.ts`
3. Add types in `src/types/index.ts`
4. Add validation in `src/services/validation.service.ts`
5. Add business logic in appropriate service
6. Update this README

## API Gateway Configuration

### Stage Variables

Set these in API Gateway for your stage:

- `S3_BUCKET_NAME` - Your S3 bucket
- `LOG_LEVEL` - `debug`, `info`, `warn`, or `error`

### CORS

All endpoints return CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type,Authorization
Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS
```

**Production:** Update `Access-Control-Allow-Origin` to your domain.

### Routes

The router automatically handles stage prefix stripping:

- API Gateway URL: `https://{api-id}.execute-api.{region}.amazonaws.com/dev/media`
- Raw path: `/dev/media`
- Processed path: `/media`

## Troubleshooting

### Common Issues

**Upload fails with 403:**
- Check Lambda IAM role has S3 permissions
- Verify bucket name is correct
- Ensure bucket exists and is accessible

**Filename validation error:**
- Check for path traversal patterns
- Ensure no dangerous characters
- Verify file extension is present

**Thumbnail not found:**
- Ensure thumbnail was uploaded with `thumbnail/` prefix
- Verify thumbnail exists at expected S3 path
- Check thumbnail filename matches original (except extension)

**List returns empty:**
- Verify userId matches uploaded files
- Check mediaType filter is correct
- Ensure files are in expected S3 structure

### Debug Logging

Enable debug logging:

```bash
export LOG_LEVEL=debug
```

Or set in Lambda environment variables.

## License

MIT
