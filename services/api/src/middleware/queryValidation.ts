import { Request } from 'express';
import { ValidationResult, ValidationError, ValidationUtils } from './validation';
import { QueryRequest } from '../types/query.types';

/**
 * Query-specific validation functions
 */
export class QueryValidators {
  /**
   * Validate query request structure
   */
  static validateQueryRequest(req: Request): ValidationResult {
    const errors: ValidationError[] = [];

    // Check if body exists
    if (!req.body) {
      errors.push({
        field: 'body',
        message: 'Request body is required',
        value: req.body
      });
      return { isValid: false, errors };
    }

    const { query, limit, threshold } = req.body as QueryRequest;

    // Validate query field
    if (!query) {
      errors.push({
        field: 'query',
        message: 'query field is required',
        value: query
      });
    } else {
      const queryError = ValidationUtils.validateStringLength(
        query,
        1,
        2000, // Max 2000 characters for query
        'query'
      );
      if (queryError) errors.push(queryError);

      // Check for potentially malicious content
      if (query.includes('<script>') || query.includes('javascript:') || query.includes('data:')) {
        errors.push({
          field: 'query',
          message: 'query contains potentially malicious content',
          value: query
        });
      }
    }

    // Validate limit if present
    if (limit !== undefined) {
      const limitError = ValidationUtils.validateNumberRange(
        limit,
        1,
        20, // Max 20 results
        'limit'
      );
      if (limitError) errors.push(limitError);
    }

    // Validate threshold if present
    if (threshold !== undefined) {
      const thresholdError = ValidationUtils.validateNumberRange(
        threshold,
        0,
        1, // Between 0 and 1
        'threshold'
      );
      if (thresholdError) errors.push(thresholdError);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
