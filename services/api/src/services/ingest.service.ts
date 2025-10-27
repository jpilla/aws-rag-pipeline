import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import crypto from "crypto";
import {
  IngestRecord,
  QueueMessage,
  QueueEntry,
  IngestResult,
  IngestError,
} from "../types/ingest.types";

/**
 * Service for handling data ingestion to SQS queue
 */
export class IngestService {
  private sqsClient: SQSClient;
  private queueUrl: string;

  constructor(queueUrl: string, region: string = "us-east-1") {
    this.queueUrl = queueUrl;
    this.sqsClient = new SQSClient({
      region,
      maxAttempts: 3,
    });
  }

  /**
   * Validates that records array is present and non-empty
   */
  validateRecords(records: any): records is IngestRecord[] {
    return Array.isArray(records) && records.length > 0;
  }

  /**
   * Generates a unique batch ID for tracking
   */
  generateBatchId(): string {
    return `b_${crypto.randomUUID()}`;
  }

  /**
   * Generates a unique chunk ID
   */
  private generateChunkId(): string {
    return `c_${crypto.randomUUID()}`;
  }

  /**
   * Generates a content hash for deduplication
   */
  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Sanitizes error codes to avoid exposing infrastructure details
   */
  private sanitizeErrorCode(rawCode: string): string {
    // Map AWS SQS error codes to generic ones
    const codeMap: Record<string, string> = {
      'InvalidParameterValue': 'INVALID_PARAMETER',
      'MessageTooLarge': 'MESSAGE_TOO_LARGE',
      'BatchEntryIdsNotDistinct': 'DUPLICATE_ENTRY',
      'TooManyEntriesInBatchRequest': 'BATCH_TOO_LARGE',
      'EmptyBatchRequest': 'EMPTY_BATCH',
      'InvalidBatchEntryId': 'INVALID_ENTRY_ID',
      'UnsupportedOperation': 'UNSUPPORTED_OPERATION',
    };

    return codeMap[rawCode] || 'PROCESSING_ERROR';
  }

  /**
   * Sanitizes error messages to avoid exposing sensitive information
   */
  private sanitizeErrorMessage(rawMessage: string): string {
    // Remove potential sensitive information
    let sanitized = rawMessage
      .replace(/https?:\/\/[^\s]+/g, '[URL]') // Remove URLs
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[UUID]') // Remove UUIDs
      .replace(/\/[^\s]*\.(js|ts|json|sql|py|go|java|cpp|c|h)/gi, '[FILE]') // Remove file paths
      .replace(/at\s+[^\s]+\s+\([^)]+\)/g, '[STACK_TRACE]') // Remove stack traces
      .replace(/Error:\s*/gi, '') // Remove "Error:" prefix
      .trim();

    // Truncate very long messages
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 197) + '...';
    }

    return sanitized || 'An error occurred during processing';
  }

  /**
   * Transforms a single record into a queue message
   */
  private createQueueMessage(
    record: IngestRecord,
    batchId: string
  ): QueueMessage {
    const content = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content);

    // Use contentHash as chunkId for consistent deduplication when chunkId not provided
    const chunkId = record.chunkId ?? this.generateContentHash(content);

    return {
      chunkId,
      clientId: record.clientId,
      content: record.content,
      metadata: record.metadata ?? {},
      batchId,
      enqueuedAt: new Date().toISOString(),
    };
  }

  /**
   * Creates SQS batch entries from records with metadata for tracking
   */
  createBatchEntries(
    records: IngestRecord[],
    batchId: string,
    startIndex: number
  ): QueueEntry[] {
    return records.map((record, idx) => {
      const message = this.createQueueMessage(record, batchId);
      return {
        Id: message.chunkId,
        MessageBody: JSON.stringify(message),
        _meta: {
          chunkId: message.chunkId,
          clientId: record.clientId,
          idx: startIndex + idx,
        },
      };
    });
  }

  /**
   * Sends a batch of entries to SQS
   */
  async sendBatch(entries: QueueEntry[]): Promise<{
    results: IngestResult[];
    errors: IngestError[];
  }> {
    const results: IngestResult[] = [];
    const errors: IngestError[] = [];

    try {
      const response = await this.sqsClient.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: entries,
        })
      );

      // Process successful messages
      response.Successful?.forEach((success) => {
        const entry = entries.find((e) => e.Id === success.Id)!;
        results.push({
          clientId: entry._meta.clientId,
          originalIndex: entry._meta.idx,
          chunkId: entry._meta.chunkId,
          messageId: success.MessageId!, // Keep for now - may be useful for debugging
          status: "enqueued",
        });
      });

      // Process failed messages
      response.Failed?.forEach((failure) => {
        const entry = entries.find((e) => e.Id === failure.Id)!;
        errors.push({
          clientId: entry._meta.clientId,
          originalIndex: entry._meta.idx,
          chunkId: entry._meta.chunkId,
          status: "rejected",
          code: this.sanitizeErrorCode(failure.Code!),
          message: this.sanitizeErrorMessage(failure.Message!),
        });
      });
    } catch (error: any) {
      // If entire batch fails, mark all entries as errors
      entries.forEach((entry) => {
        errors.push({
          clientId: entry._meta.clientId,
          originalIndex: entry._meta.idx,
          chunkId: entry._meta.chunkId,
          status: "rejected",
          code: "BATCH_ERROR",
          message: this.sanitizeErrorMessage(error.message ?? String(error)),
        });
      });
    }

    return { results, errors };
  }

  /**
   * Processes records in batches of 10 (SQS batch limit) with parallel execution
   */
  async processRecords(
    records: IngestRecord[],
    batchId: string
  ): Promise<{
    results: IngestResult[];
    errors: IngestError[];
  }> {
    const BATCH_SIZE = 10;
    const allResults: IngestResult[] = [];
    const allErrors: IngestError[] = [];

    // Create all batch entries upfront
    const batchEntries: QueueEntry[][] = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const slice = records.slice(i, i + BATCH_SIZE);
      const entries = this.createBatchEntries(slice, batchId, i);
      batchEntries.push(entries);
    }

    // Process all batches in parallel
    const batchPromises = batchEntries.map(entries => this.sendBatch(entries));
    const batchResults = await Promise.all(batchPromises);

    // Combine all results
    batchResults.forEach(({ results, errors }) => {
      allResults.push(...results);
      allErrors.push(...errors);
    });

    return { results: allResults, errors: allErrors };
  }

  /**
   * Main entry point for ingesting records
   */
  async ingest(records: IngestRecord[]): Promise<{
    batchId: string;
    results: IngestResult[];
    errors: IngestError[];
  }> {
    const startTime = Date.now();
    const batchId = this.generateBatchId();

    console.log(`Starting ingest for batch ${batchId} with ${records.length} records`);

    const { results, errors } = await this.processRecords(records, batchId);

    const duration = Date.now() - startTime;
    console.log(`Completed ingest for batch ${batchId} in ${duration}ms - ${results.length} successful, ${errors.length} failed`);

    return { batchId, results, errors };
  }
}
