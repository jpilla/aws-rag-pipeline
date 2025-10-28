import { Request, Response, NextFunction } from 'express';

/**
 * Validation error interface
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

/**
 * Common validation functions
 */
export class ValidationUtils {
  /**
   * Check if content type is JSON
   */
  static isJsonContentType(contentType: string): boolean {
    return contentType === 'application/json' ||
           contentType.startsWith('application/json;') ||
           contentType === 'application/*+json';
  }

  /**
   * Check if charset is UTF-8
   */
  static isUtf8Charset(contentType: string): boolean {
    return contentType.includes('charset=utf-8') ||
           !contentType.includes('charset=') || // Default to UTF-8 if no charset specified
           contentType.includes('charset=UTF-8');
  }

  /**
   * Validate string length
   */
  static validateStringLength(value: string, min: number, max: number, fieldName: string): ValidationError | null {
    if (typeof value !== 'string') {
      return { field: fieldName, message: `${fieldName} must be a string`, value };
    }
    if (value.length < min) {
      return { field: fieldName, message: `${fieldName} must be at least ${min} characters long`, value };
    }
    if (value.length > max) {
      return { field: fieldName, message: `${fieldName} must be no more than ${max} characters long`, value };
    }
    return null;
  }

  /**
   * Validate number range
   */
  static validateNumberRange(value: number, min: number, max: number, fieldName: string): ValidationError | null {
    if (typeof value !== 'number' || isNaN(value)) {
      return { field: fieldName, message: `${fieldName} must be a valid number`, value };
    }
    if (value < min) {
      return { field: fieldName, message: `${fieldName} must be at least ${min}`, value };
    }
    if (value > max) {
      return { field: fieldName, message: `${fieldName} must be no more than ${max}`, value };
    }
    return null;
  }

  /**
   * Validate array length
   */
  static validateArrayLength(value: any[], min: number, max: number, fieldName: string): ValidationError | null {
    if (!Array.isArray(value)) {
      return { field: fieldName, message: `${fieldName} must be an array`, value };
    }
    if (value.length < min) {
      return { field: fieldName, message: `${fieldName} must contain at least ${min} items`, value };
    }
    if (value.length > max) {
      return { field: fieldName, message: `${fieldName} must contain no more than ${max} items`, value };
    }
    return null;
  }

  /**
   * Validate required fields
   */
  static validateRequiredFields(obj: any, requiredFields: string[]): ValidationError[] {
    const errors: ValidationError[] = [];
    for (const field of requiredFields) {
      if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
        errors.push({ field, message: `${field} is required` });
      }
    }
    return errors;
  }

  /**
   * Validate UUID format
   */
  static validateUuid(value: string, fieldName: string): ValidationError | null {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(value)) {
      return { field: fieldName, message: `${fieldName} must be a valid UUID`, value };
    }
    return null;
  }
}

/**
 * Common validation middleware for all endpoints
 */
export const commonValidationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const errors: ValidationError[] = [];

  // Check content type for POST/PUT/PATCH requests
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.get('Content-Type') || '';

    if (!ValidationUtils.isJsonContentType(contentType)) {
      errors.push({
        field: 'Content-Type',
        message: 'Content-Type must be application/json',
        value: contentType
      });
    }

    if (!ValidationUtils.isUtf8Charset(contentType)) {
      errors.push({
        field: 'Content-Type',
        message: 'Charset must be UTF-8',
        value: contentType
      });
    }
  }

  // Check request size (Express already handles this with limit, but we can add custom logic)
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSizeBytes = 1024 * 1024; // 1MB

  if (contentLength > maxSizeBytes) {
    errors.push({
      field: 'Content-Length',
      message: `Request body must be no larger than ${maxSizeBytes} bytes (1MB)`,
      value: contentLength
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      message: 'Request validation failed',
      details: errors
    });
  }

  next();
};

/**
 * Generic validation middleware factory
 */
export const createValidationMiddleware = (validator: (req: Request) => ValidationResult) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = validator(req);

    if (!result.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Request validation failed',
        details: result.errors
      });
    }

    next();
  };
};

/**
 * Send validation error response
 */
export const sendValidationError = (res: Response, errors: ValidationError[], statusCode: number = 400) => {
  res.status(statusCode).json({
    error: 'Validation failed',
    message: 'Request validation failed',
    details: errors
  });
};
