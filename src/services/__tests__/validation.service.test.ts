/**
 * Validation Service Tests
 */

import { ValidationService } from '../validation.service';
import { MediaFile } from '../../types';
import { ValidationError } from '../../errors/AppError';

describe('ValidationService', () => {
  let validationService: ValidationService;

  beforeEach(() => {
    validationService = new ValidationService();
  });

  describe('validateFiles', () => {
    it('should validate valid files successfully', () => {
      const files: MediaFile[] = [
        {
          filename: 'test-image.jpg',
          fileType: 'image/jpeg',
          fileSize: 1024 * 1024, // 1MB
        },
        {
          filename: 'test-video.mp4',
          fileType: 'video/mp4',
          fileSize: 10 * 1024 * 1024, // 10MB
        },
      ];

      const result = validationService.validateFiles(files);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should throw error for empty files array', () => {
      expect(() => {
        validationService.validateFiles([]);
      }).toThrow(ValidationError);
    });

    it('should throw error for non-array files', () => {
      expect(() => {
        validationService.validateFiles(null as any);
      }).toThrow(ValidationError);
    });

    it('should throw error for invalid file type', () => {
      const files: MediaFile[] = [
        {
          filename: 'test.exe',
          fileType: 'application/x-msdownload',
          fileSize: 1024,
        },
      ];

      expect(() => {
        validationService.validateFiles(files);
      }).toThrow(ValidationError);
    });

    it('should throw error for file too large', () => {
      const files: MediaFile[] = [
        {
          filename: 'large-file.mp4',
          fileType: 'video/mp4',
          fileSize: 10 * 1024 * 1024 * 1024, // 10GB (exceeds default 5GB limit)
        },
      ];

      expect(() => {
        validationService.validateFiles(files);
      }).toThrow(ValidationError);
    });

    it('should throw error for filename with path traversal', () => {
      const files: MediaFile[] = [
        {
          filename: '../../../etc/passwd',
          fileType: 'image/jpeg',
          fileSize: 1024,
        },
      ];

      expect(() => {
        validationService.validateFiles(files);
      }).toThrow(ValidationError);
    });

    it('should throw error for filename with invalid characters', () => {
      const files: MediaFile[] = [
        {
          filename: 'test<script>.jpg',
          fileType: 'image/jpeg',
          fileSize: 1024,
        },
      ];

      expect(() => {
        validationService.validateFiles(files);
      }).toThrow(ValidationError);
    });

    it('should throw error for missing required fields', () => {
      const files: MediaFile[] = [
        {
          filename: '',
          fileType: 'image/jpeg',
          fileSize: 1024,
        },
      ];

      expect(() => {
        validationService.validateFiles(files);
      }).toThrow(ValidationError);
    });
  });

  describe('sanitizeFilename', () => {
    it('should sanitize filename correctly', () => {
      const result = validationService.sanitizeFilename('Test File (1).jpg');
      expect(result).toBe('Test_File_1.jpg');
    });

    it('should remove path components', () => {
      const result = validationService.sanitizeFilename('../../test.jpg');
      expect(result).toBe('test.jpg');
    });

    it('should remove invalid characters', () => {
      const result = validationService.sanitizeFilename('test<>:"|?*.jpg');
      expect(result).toBe('test.jpg');
    });

    it('should replace spaces with underscores', () => {
      const result = validationService.sanitizeFilename('my test file.jpg');
      expect(result).toBe('my_test_file.jpg');
    });
  });
});
