import { SendMessageBatchCommand, GetQueueAttributesCommand, SendMessageBatchCommandOutput, GetQueueAttributesCommandOutput, SendMessageBatchResultEntry, BatchResultErrorEntry } from "@aws-sdk/client-sqs";
import crypto from "crypto";
import {
  IngestRecord,
  IngestRecordWithId,
  QueueMessage,
  QueueEntry,
  IngestResult,
  IngestError,
} from "../types/ingest.types";
import { logger } from "../lib/logger";

export interface ChunkData {
  id: string;
  clientId: string;
  chunkIndex: number;
  status: 'ENQUEUED' | 'INGESTED' | 'FAILED';
  failureReason?: string;
}

export interface DatabaseService {
  getBatchByKey(idempotencyKey: string): Promise<{ success: boolean; batchId?: string }>;
  getChunksByBatchId(batchId: string): Promise<{ success: boolean; chunks?: ChunkData[]; error?: string }>;
  storeIdempotencyKey(idempotencyKey: string, batchId: string): Promise<void>;
}

export interface SqsService {
  sendMessageBatch(command: SendMessageBatchCommand): Promise<SendMessageBatchCommandOutput>;
  getQueueAttributes(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput>;
}

/**
 * Service for handling data ingestion to SQS queue
 */
export class IngestService {
  private sqsService: SqsService;
  private databaseService: DatabaseService;
  private queueUrl: string;
  private isInitialized: boolean = false;

  constructor(
    queueUrl: string,
    databaseService: DatabaseService,
    sqsService: SqsService
  ) {
    this.queueUrl = queueUrl;
    this.databaseService = databaseService;
    this.sqsService = sqsService;
  }

  /**
   * Initialize the SQS client and test connectivity
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Test SQS connectivity by getting queue attributes
      const { GetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
      await this.sqsService.getQueueAttributes(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ["QueueArn"]
        })
      );

      this.isInitialized = true;
      logger.info({ queueUrl: this.queueUrl }, "SQS client initialized");
    } catch (error: any) {
      const errorDetails = {
        message: error?.message || String(error),
        code: error?.Code || error?.code,
        name: error?.name,
        $metadata: error?.$metadata,
        stack: error?.stack
      };
      logger.error({ error: errorDetails }, "Failed to initialize SQS client");
      throw new Error(`SQS client initialization failed: ${error?.message || String(error)}`);
    }
  }

  /**
   * Validates that records array is present and non-empty
   */
  private validateRecords(records: unknown): records is IngestRecord[] {
    return Array.isArray(records) && records.length > 0;
  }

  /**
   * Generates a unique batch ID for tracking
   */
  private generateBatchId(): string {
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
    record: IngestRecordWithId,
    batchId: string,
    originalIndex: number,
    requestId?: string
  ): QueueMessage {
    const content = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content);

    // chunkId is now always provided (computed at API level)
    const chunkId = record.chunkId;

    // Always compute contentHash for deduplication
    const contentHash = this.generateContentHash(content);

    return {
      chunkId,
      clientId: record.clientId,
      content: record.content,
      metadata: {
        ...record.metadata ?? {},
        ...(requestId && { requestId })
      },
      batchId,
      enqueuedAt: new Date().toISOString(),
      contentHash,
      originalIndex,
    };
  }

  /**
   * Creates SQS batch entries from records with metadata for tracking
   */
  private createBatchEntries(
    records: IngestRecordWithId[],
    batchId: string,
    startIndex: number,
    requestId?: string
  ): QueueEntry[] {
    return records.map((record, idx) => {
      const originalIndex = startIndex + idx;
      const message = this.createQueueMessage(record, batchId, originalIndex, requestId);
      return {
        Id: message.chunkId,
        MessageBody: JSON.stringify(message),
        _meta: {
          chunkId: message.chunkId,
          clientId: record.clientId,
          idx: originalIndex,
        },
      };
    });
  }

  /**
   * Sends a batch of entries to SQS
   */
  private async sendBatch(entries: QueueEntry[]): Promise<{
    results: IngestResult[];
    errors: IngestError[];
  }> {
    try {
      const response = await this.sendBatchToSqs(entries);
      return this.processSqsResponse(response, entries);
    } catch (error: unknown) {
      return this.handleBatchFailure(entries, error);
    }
  }

  private async sendBatchToSqs(entries: QueueEntry[]) {
    return this.sqsService.sendMessageBatch(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: entries,
      })
    );
  }

  private processSqsResponse(response: SendMessageBatchCommandOutput, entries: QueueEntry[]): { results: IngestResult[]; errors: IngestError[] } {
    const results: IngestResult[] = [];
    const errors: IngestError[] = [];

    this.processSuccessfulMessages(response.Successful || [], entries, results);
    this.processFailedMessages(response.Failed || [], entries, errors);

    return { results, errors };
  }

  private processSuccessfulMessages(successful: SendMessageBatchResultEntry[], entries: QueueEntry[], results: IngestResult[]) {
    successful?.forEach((success) => {
      const entry = entries.find((e) => e.Id === success.Id)!;
      results.push({
        clientId: entry._meta.clientId,
        originalIndex: entry._meta.idx,
        chunkId: entry._meta.chunkId,
        status: "ENQUEUED",
      });
    });
  }

  private processFailedMessages(failed: BatchResultErrorEntry[], entries: QueueEntry[], errors: IngestError[]) {
    failed?.forEach((failure) => {
      const entry = entries.find((e) => e.Id === failure.Id)!;
      errors.push({
        clientId: entry._meta.clientId,
        originalIndex: entry._meta.idx,
        chunkId: entry._meta.chunkId,
        status: "REJECTED",
        code: this.sanitizeErrorCode(failure.Code!),
        message: this.sanitizeErrorMessage(failure.Message!),
      });
    });
  }

  private handleBatchFailure(entries: QueueEntry[], error: unknown): { results: IngestResult[]; errors: IngestError[] } {
    const errors: IngestError[] = [];

    entries.forEach((entry) => {
      errors.push({
        clientId: entry._meta.clientId,
        originalIndex: entry._meta.idx,
        chunkId: entry._meta.chunkId,
        status: "REJECTED",
        code: "BATCH_ERROR",
        message: this.sanitizeErrorMessage((error as Error)?.message ?? String(error)),
      });
    });

    return { results: [], errors };
  }

  /**
   * Processes records in batches of 10 (SQS batch limit) with parallel execution
   */
  private async processRecords(
    records: IngestRecordWithId[],
    batchId: string,
    requestId?: string
  ): Promise<{
    results: IngestResult[];
    errors: IngestError[];
  }> {
    const batchEntries = this.createAllBatchEntries(records, batchId, requestId);
    const batchResults = await this.processAllBatchesInParallel(batchEntries);
    return this.combineAllBatchResults(batchResults);
  }

  private createAllBatchEntries(records: IngestRecordWithId[], batchId: string, requestId?: string): QueueEntry[][] {
    const BATCH_SIZE = 10;
    const batchEntries: QueueEntry[][] = [];

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const slice = records.slice(i, i + BATCH_SIZE);
      const entries = this.createBatchEntries(slice, batchId, i, requestId);
      batchEntries.push(entries);
    }

    return batchEntries;
  }

  private async processAllBatchesInParallel(batchEntries: QueueEntry[][]): Promise<{ results: IngestResult[]; errors: IngestError[] }[]> {
    const batchPromises = batchEntries.map(entries => this.sendBatch(entries));
    return Promise.all(batchPromises);
  }

  private combineAllBatchResults(batchResults: { results: IngestResult[]; errors: IngestError[] }[]): { results: IngestResult[]; errors: IngestError[] } {
    const allResults: IngestResult[] = [];
    const allErrors: IngestError[] = [];

    batchResults.forEach(({ results, errors }) => {
      allResults.push(...results);
      allErrors.push(...errors);
    });

    return { results: allResults, errors: allErrors };
  }

  /**
   * Preprocesses input records by generating chunkIds for each record
   */
  private preprocessRecords(records: IngestRecord[]): IngestRecordWithId[] {
    return records.map(record => ({
      ...record,
      chunkId: this.generateChunkId()
    }));
  }

  private async tryGetExistingBatch(idempotencyKey?: string) {
    if (!idempotencyKey) {
      return null;
    }

    const existingBatch = await this.getExistingBatch(idempotencyKey);
    if (existingBatch) {
      logger.info({ batchId: existingBatch.batchId, idempotencyKey }, "Found existing batch for idempotency key - will re-enqueue (lambda deduplicates)");
    }
    return existingBatch;
  }

  private prepareRecordsForProcessing(records: IngestRecord[]): IngestRecordWithId[] {
    const preprocessedRecords = this.preprocessRecords(records);
    return this.deduplicateRecords(preprocessedRecords);
  }

  private async storeIdempotencyKeyIfProvided(idempotencyKey?: string, batchId?: string) {
    if (idempotencyKey && batchId) {
      await this.storeIdempotencyMapping(idempotencyKey, batchId);
    }
  }

  private logBatchCompletion(batchId: string, startTime: number, successCount: number, errorCount: number) {
    const duration = Date.now() - startTime;
    logger.info({ batchId, duration, successful: successCount, failed: errorCount }, "Completed ingest for batch");
  }

  /**
   * Main entry point for ingesting records
   * Note: Even with idempotency key match, we still enqueue records.
   * The lambda consumer will deduplicate at the database level.
   */
  async ingest(records: IngestRecord[], idempotencyKey?: string, requestId?: string): Promise<{
    batchId: string;
    results: IngestResult[];
    errors: IngestError[];
  }> {
    const startTime = Date.now();

    // Check for existing batch via idempotency key, but don't return early
    // We'll still process and enqueue records - the lambda consumer will deduplicate
    let batchId: string;
    const existingBatch = await this.tryGetExistingBatch(idempotencyKey);
    if (existingBatch) {
      batchId = existingBatch.batchId;
      logger.info({ batchId, idempotencyKey }, "Idempotency match found - re-enqueueing (lambda will deduplicate)");
    } else {
      batchId = this.generateBatchId();
    }

    const processedRecords = this.prepareRecordsForProcessing(records);

    logger.info({ batchId, totalRecords: records.length, processedRecords: processedRecords.length }, "Starting ingest for batch");

    const { results, errors } = await this.processRecords(processedRecords, batchId, requestId);

    // Only store idempotency key if this is a new batch (not an existing one)
    if (!existingBatch) {
      await this.storeIdempotencyKeyIfProvided(idempotencyKey, batchId);
    }

    this.logBatchCompletion(batchId, startTime, results.length, errors.length);
    return { batchId, results, errors };
  }

  /**
   * Get existing batch by idempotency key
   * Returns batchId if found, client should check GET endpoint for detailed status
   */
  private async getExistingBatch(idempotencyKey: string): Promise<{
    batchId: string;
    results: IngestResult[];
    errors: IngestError[];
  } | null> {
    try {
      const batchResult = await this.databaseService.getBatchByKey(idempotencyKey);
      if (!batchResult.success || !batchResult.batchId) {
        return null;
      }

      logger.info({ batchId: batchResult.batchId, idempotencyKey },
        "Idempotency match found - returning batchId, client should check GET endpoint for status");

      // For idempotency matches, return batchId with empty arrays
      // Client should poll GET /v1/ingest/:batchId for detailed status
      // This simplifies the code and aligns with 202 Accepted pattern
      return {
        batchId: batchResult.batchId,
        results: [], // Status available via GET endpoint
        errors: []
      };
    } catch (error) {
      logger.error({ error, idempotencyKey }, "Failed to get existing batch for idempotency key");
      throw new Error(`Failed to check idempotency for key ${idempotencyKey}: ${error}`);
    }
  }

  /**
   * Store idempotency key mapping
   */
  private async storeIdempotencyMapping(idempotencyKey: string, batchId: string): Promise<void> {
    try {
      await this.databaseService.storeIdempotencyKey(idempotencyKey, batchId);
    } catch (error) {
      logger.error({ error, idempotencyKey, batchId }, "Failed to store idempotency mapping");
      throw new Error(`Failed to store idempotency mapping for key ${idempotencyKey}: ${error}`);
    }
  }

  /**
   * Deduplicates records within a batch based on content hash
   * Keeps the first occurrence of each unique content
   */
  private deduplicateRecords(records: IngestRecordWithId[]): IngestRecordWithId[] {
    const seenContentHashes = new Set<string>();
    const deduplicated: IngestRecordWithId[] = [];

    for (const record of records) {
      const content = typeof record.content === 'string'
        ? record.content
        : JSON.stringify(record.content);
      const contentHash = this.generateContentHash(content);

      if (!seenContentHashes.has(contentHash)) {
        seenContentHashes.add(contentHash);
        deduplicated.push(record);
      }
    }

    return deduplicated;
  }
}

/**
 * Factory function to create IngestService with injected dependencies
 * Dependencies should be created outside and injected for better testability
 */
export function createIngestService(
  queueUrl: string,
  databaseService: DatabaseService,
  sqsService: SqsService
): IngestService {
  return new IngestService(queueUrl, databaseService, sqsService);
}
