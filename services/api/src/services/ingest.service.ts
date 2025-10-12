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
    this.sqsClient = new SQSClient({ region });
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
   * Transforms a single record into a queue message
   */
  private createQueueMessage(
    record: IngestRecord,
    batchId: string
  ): QueueMessage {
    return {
      chunkId: record.chunkId ?? this.generateChunkId(),
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
          messageId: success.MessageId!,
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
          code: failure.Code!,
          message: failure.Message!,
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
          code: "BatchError",
          message: error.message ?? String(error),
        });
      });
    }

    return { results, errors };
  }

  /**
   * Processes records in batches of 10 (SQS batch limit)
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

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const slice = records.slice(i, i + BATCH_SIZE);
      const entries = this.createBatchEntries(slice, batchId, i);
      const { results, errors } = await this.sendBatch(entries);

      allResults.push(...results);
      allErrors.push(...errors);
    }

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
    const batchId = this.generateBatchId();
    const { results, errors } = await this.processRecords(records, batchId);

    return { batchId, results, errors };
  }
}

