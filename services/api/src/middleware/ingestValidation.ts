import { Request } from 'express';
import { ValidationResult, ValidationError, ValidationUtils } from './validation';
import { IngestRecord } from '../types/ingest.types';

/**
 * Ingest-specific validation functions
 */
export class IngestValidators {
  /**
   * Validate ingest record structure
   */
  static validateIngestRecord(record: any, index: number): ValidationError[] {
    const errors: ValidationError[] = [];
    const fieldPrefix = `records[${index}]`;

    // Check required fields
    const requiredFields = ['clientId', 'content'];
    for (const field of requiredFields) {
      if (record[field] === undefined || record[field] === null) {
        errors.push({
          field: `${fieldPrefix}.${field}`,
          message: `${field} is required`,
          value: record[field]
        });
      }
    }

    // Validate clientId
    if (record.clientId !== undefined) {
      const clientIdError = ValidationUtils.validateStringLength(
        record.clientId,
        1,
        255,
        `${fieldPrefix}.clientId`
      );
      if (clientIdError) errors.push(clientIdError);
    }

    // Validate content
    if (record.content !== undefined) {
      if (typeof record.content !== 'string') {
        errors.push({
          field: `${fieldPrefix}.content`,
          message: 'content must be a string',
          value: record.content
        });
      } else {
        const contentError = ValidationUtils.validateStringLength(
          record.content,
          1,
          100000, // 100KB max per record content
          `${fieldPrefix}.content`
        );
        if (contentError) errors.push(contentError);
      }
    }

    // Validate metadata if present
    if (record.metadata !== undefined) {
      if (typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
        errors.push({
          field: `${fieldPrefix}.metadata`,
          message: 'metadata must be an object',
          value: record.metadata
        });
      } else {
        // Check metadata size (serialized JSON)
        const metadataStr = JSON.stringify(record.metadata);
        if (metadataStr.length > 10000) { // 10KB max for metadata
          errors.push({
            field: `${fieldPrefix}.metadata`,
            message: 'metadata must be no larger than 10KB when serialized',
            value: record.metadata
          });
        }
      }
    }

    return errors;
  }

  /**
   * Validate ingest request structure
   */
  static validateIngestRequest(req: Request): ValidationResult {
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

    // Check if records field exists
    if (!req.body.records) {
      errors.push({
        field: 'records',
        message: 'records field is required',
        value: req.body.records
      });
      return { isValid: false, errors };
    }

    // Validate records array
    const recordsError = ValidationUtils.validateArrayLength(
      req.body.records,
      1,
      100, // Max 100 records per batch
      'records'
    );
    if (recordsError) errors.push(recordsError);

    // Validate each record
    if (Array.isArray(req.body.records)) {
      req.body.records.forEach((record: any, index: number) => {
        const recordErrors = IngestValidators.validateIngestRecord(record, index);
        errors.push(...recordErrors);
      });
    }

    // Validate idempotency key if present
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    if (idempotencyKey) {
      const keyError = ValidationUtils.validateStringLength(
        idempotencyKey as string,
        1,
        255,
        'idempotency-key'
      );
      if (keyError) errors.push(keyError);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate batch ID parameter
   */
  static validateBatchId(batchId: string): ValidationResult {
    const errors: ValidationError[] = [];

    if (!batchId) {
      errors.push({
        field: 'batchId',
        message: 'batchId parameter is required',
        value: batchId
      });
    } else {
      // Validate UUID format
      const uuidError = ValidationUtils.validateUuid(batchId, 'batchId');
      if (uuidError) errors.push(uuidError);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
