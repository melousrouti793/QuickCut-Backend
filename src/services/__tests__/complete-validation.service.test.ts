/**
 * Complete Upload Validation Service Tests
 */

import { ValidationService } from '../validation.service';
import { CompleteUploadRequest, UploadPart } from '../../types';
import { ValidationError } from '../../errors/AppError';

describe('ValidationService - Complete Upload', () => {
  let validationService: ValidationService;

  beforeEach(() => {
    validationService = new ValidationService();
  });

  describe('validateCompleteUploadRequest', () => {
    it('should validate valid complete upload request', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/550e8400-e29b-41d4-a716-446655440000/test.mp4',
        uploadId: 'valid-upload-id-from-s3',
        parts: [
          { partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' },
          { partNumber: 2, etag: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
        ],
      };

      const result = validationService.validateCompleteUploadRequest(request);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should throw error for missing fileId', () => {
      const request = {
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [{ partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' }],
      } as CompleteUploadRequest;

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for missing s3Key', () => {
      const request = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        uploadId: 'valid-upload-id',
        parts: [{ partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' }],
      } as CompleteUploadRequest;

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for missing uploadId', () => {
      const request = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        parts: [{ partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' }],
      } as CompleteUploadRequest;

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for missing parts array', () => {
      const request = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
      } as CompleteUploadRequest;

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for invalid UUID format', () => {
      const request: CompleteUploadRequest = {
        fileId: 'invalid-uuid',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [{ partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' }],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for invalid s3Key with path traversal', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/../../../etc/passwd',
        uploadId: 'valid-upload-id',
        parts: [{ partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' }],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for empty parts array', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for parts not in ascending order', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [
          { partNumber: 2, etag: 'd41d8cd98f00b204e9800998ecf8427e' },
          { partNumber: 1, etag: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
        ],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for duplicate part numbers', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [
          { partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' },
          { partNumber: 1, etag: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
        ],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for gaps in part numbers', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [
          { partNumber: 1, etag: 'd41d8cd98f00b204e9800998ecf8427e' },
          { partNumber: 3, etag: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
        ],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should throw error for invalid ETag', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [
          { partNumber: 1, etag: 'tooshort' },
        ],
      };

      expect(() => {
        validationService.validateCompleteUploadRequest(request);
      }).toThrow(ValidationError);
    });

    it('should accept ETags with quotes and strip them', () => {
      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts: [
          { partNumber: 1, etag: '"d41d8cd98f00b204e9800998ecf8427e"' },
        ],
      };

      const result = validationService.validateCompleteUploadRequest(request);

      expect(result.isValid).toBe(true);
    });

    it('should validate request with many parts', () => {
      const parts: UploadPart[] = Array.from({ length: 100 }, (_, i) => ({
        partNumber: i + 1,
        etag: `d41d8cd98f00b204e9800998ecf8427${i}`,
      }));

      const request: CompleteUploadRequest = {
        fileId: '550e8400-e29b-41d4-a716-446655440000',
        s3Key: 'uploads/user123/2024/01/15/test.mp4',
        uploadId: 'valid-upload-id',
        parts,
      };

      const result = validationService.validateCompleteUploadRequest(request);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
