# QuickCut Media Upload Backend

AWS Lambda backend for media uploads and management.

## Environment Variables

```bash
S3_BUCKET_NAME=quickcut-media-uploads        # Required - uploads bucket
S3_LOWRES_BUCKET_NAME=quickcut-lowres        # Required - lowres previews bucket
DYNAMODB_TABLE=quickcut-media                # Required - DynamoDB table
AWS_REGION=us-east-1                         # Optional
```

## API Endpoints

All endpoints require authentication via API Gateway Lambda authorizer.

---

### POST /upload/initiate

Initiates multipart upload for one or more files.

**Request:**
```json
{
  "files": [
    {
      "filename": "vacation.mp4",
      "fileType": "video/mp4",
      "fileSize": 52428800
    },
    {
      "filename": "sunset.jpg",
      "fileType": "image/jpeg",
      "fileSize": 2097152
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
        "s3Key": "user_abc123/videos/550e8400-e29b-41d4-a716-446655440000/vacation.mp4",
        "bucket": "quickcut-media-uploads",
        "uploadId": "VXBsb2FkSWQ...",
        "parts": [
          { "partNumber": 1, "url": "https://s3.amazonaws.com/..." },
          { "partNumber": 2, "url": "https://s3.amazonaws.com/..." }
        ],
        "filename": "vacation.mp4",
        "fileType": "video/mp4",
        "expiresAt": "2025-11-28T01:00:00.000Z"
      }
    ],
    "totalFiles": 2
  }
}
```

---

### POST /upload/complete

Completes a multipart upload after all parts have been uploaded.

**Request:**
```json
{
  "fileId": "550e8400-e29b-41d4-a716-446655440000",
  "s3Key": "user_abc123/videos/550e8400-e29b-41d4-a716-446655440000/vacation.mp4",
  "uploadId": "VXBsb2FkSWQ...",
  "parts": [
    { "partNumber": 1, "etag": "a54357aff0632cce46d942af68356b38" },
    { "partNumber": 2, "etag": "0dc9f8eb616a1234567890abcdef1234" }
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
    "bucket": "quickcut-media-uploads",
    "s3Key": "user_abc123/videos/550e8400-e29b-41d4-a716-446655440000/vacation.mp4",
    "location": "https://quickcut-media-uploads.s3.amazonaws.com/...",
    "metadata": {
      "filename": "vacation.mp4",
      "fileType": "video/mp4",
      "uploadedAt": "2025-11-28T00:30:00.000Z"
    }
  }
}
```

---

### GET /media

Lists user's media files with optional filtering and pagination.

**Query Parameters:**
- `mediaType`: `videos` | `images` | `audios` | `visual` (videos + images)
- `limit`: Results per page (default: 50, max: 1000)
- `continuationToken`: Pagination token

**Request:**
```
GET /media?mediaType=videos&limit=10
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Media files retrieved successfully",
  "data": {
    "files": [
      {
        "mediaId": "550e8400-e29b-41d4-a716-446655440000",
        "filename": "vacation.mp4",
        "mediaType": "video",
        "mimeType": "video/mp4",
        "size": 52428800,
        "uploadedAt": "2025-11-28T00:30:00.000Z",
        "status": "ready",
        "previewUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
        "thumbnailUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
        "duration": 127.4,
        "width": 1280,
        "height": 720,
        "sceneCount": 5
      },
      {
        "mediaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "filename": "sunset.jpg",
        "mediaType": "image",
        "mimeType": "image/jpeg",
        "size": 2097152,
        "uploadedAt": "2025-11-28T00:42:00.000Z",
        "status": "ready",
        "previewUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
        "width": 1080,
        "height": 720,
        "description": "A golden sunset over the ocean with silhouetted palm trees."
      },
      {
        "mediaId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "filename": "podcast.mp3",
        "mediaType": "audio",
        "mimeType": "audio/mpeg",
        "size": 8388608,
        "uploadedAt": "2025-11-28T00:38:00.000Z",
        "status": "ready",
        "url": "https://quickcut-media-uploads.s3.amazonaws.com/...",
        "duration": 185.6,
        "segmentCount": 7
      }
    ],
    "count": 3,
    "hasMore": true,
    "nextToken": "eyJQSyI6IlVTRVIjdXNlcl9hYmMxMjMi..."
  }
}
```

---

### GET /media/search

Searches media files by partial filename match.

**Query Parameters:**
- `query` (required): Search string
- `mediaType`: Filter by type
- `limit`: Results per page

**Request:**
```
GET /media/search?query=vacation&mediaType=videos
```

**Response:**
```json
{
  "statusCode": 200,
  "message": "Search completed successfully",
  "data": {
    "query": "vacation",
    "mediaType": "videos",
    "files": [
      {
        "mediaId": "550e8400-e29b-41d4-a716-446655440000",
        "filename": "vacation.mp4",
        "mediaType": "video",
        "mimeType": "video/mp4",
        "size": 52428800,
        "uploadedAt": "2025-11-28T00:30:00.000Z",
        "status": "ready",
        "previewUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
        "thumbnailUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
        "duration": 127.4,
        "width": 1280,
        "height": 720,
        "sceneCount": 5
      }
    ],
    "count": 1,
    "hasMore": false
  }
}
```

---

### DELETE /media

Deletes one or more media files from S3 and DynamoDB.

**Request:**
```json
{
  "mediaIds": [
    "550e8400-e29b-41d4-a716-446655440000",
    "7c9e6679-7425-40de-944b-e07fc1f90ae7"
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
      "550e8400-e29b-41d4-a716-446655440000",
      "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    ],
    "failed": [],
    "totalRequested": 2,
    "successCount": 2,
    "failureCount": 0
  }
}
```

---

### PATCH /media/rename

Renames a media file (updates DynamoDB only, S3 keys unchanged).

**Request:**
```json
{
  "mediaId": "550e8400-e29b-41d4-a716-446655440000",
  "newFilename": "beach_trip.mp4"
}
```

**Response (Video):**
```json
{
  "statusCode": 200,
  "message": "File renamed successfully",
  "data": {
    "mediaId": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "beach_trip.mp4",
    "mediaType": "video",
    "mimeType": "video/mp4",
    "size": 52428800,
    "uploadedAt": "2025-11-28T00:30:00.000Z",
    "status": "ready",
    "previewUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
    "thumbnailUrl": "https://quickcut-lowres.s3.amazonaws.com/...",
    "duration": 127.4,
    "width": 1280,
    "height": 720,
    "sceneCount": 5
  }
}
```

---

## Build and Deploy

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run package      # Build and create function.zip
npm run deploy       # Deploy to Lambda
```
