import { logger } from "./logger.js";
import { DatabaseService } from "./services/database.service.js";
import { EmbeddingService } from "./services/embedding.service.js";
import { PrismaClient } from "@prisma/client";

export type Payload = {
  chunkId: string;
  clientId: string;
  content: any;
  metadata: Record<string, any>;
  batchId: string;
  enqueuedAt: string;
  contentHash: string;
  originalIndex: number;
};

export type ProcessedRecord = {
  messageId: string;
  payload: Payload;
  success: boolean;
  error?: string;
};

type RecordWithProcessedContent = {
  messageId: string;
  payload: Payload;
  processedContent: string;
  chunkId: string;
  contentHash: string;
};

export class BatchProcessor {
  constructor(
    private databaseService: DatabaseService,
    private embeddingService: EmbeddingService
  ) {}

  async processBatch(
    records: Array<{ messageId: string; payload: Payload }>
  ): Promise<ProcessedRecord[]> {
    logger.info({ recordCount: records.length }, "Processing batch of SQS messages");

    try {
      const processedRecords = this.prepareRecordsForProcessing(records);
      await this.insertChunksAndPlaceholders(processedRecords);
      const recordsNeedingEmbeddings = await this.filterRecordsNeedingEmbeddings(
        processedRecords
      );
      const embeddings = await this.generateEmbeddingsIfNeeded(
        recordsNeedingEmbeddings
      );
      await this.updateDatabaseWithEmbeddingsAndStatus(
        processedRecords,
        recordsNeedingEmbeddings,
        embeddings
      );

      return this.createSuccessResults(processedRecords);
    } catch (error) {
      logger.error({ error, recordCount: records.length }, "Critical batch processing failure");
      return this.createFailureResultsForAllRecords(records, error);
    }
  }

  private prepareRecordsForProcessing(
    records: Array<{ messageId: string; payload: Payload }>
  ): RecordWithProcessedContent[] {
    return records.map((record) => {
      const content =
        typeof record.payload.content === "string"
          ? record.payload.content
          : JSON.stringify(record.payload.content);

      return {
        ...record,
        processedContent: content,
        chunkId: record.payload.chunkId,
        contentHash: record.payload.contentHash,
      };
    });
  }

  private async insertChunksAndPlaceholders(
    processedRecords: RecordWithProcessedContent[]
  ): Promise<void> {
    logger.info(
      { recordCount: processedRecords.length },
      "Phase 1: Inserting chunks and placeholder embeddings"
    );

    const contentHashes = processedRecords.map((r) => r.contentHash);
    const chunkIds = processedRecords.map((r) => r.chunkId);
    const batchIds = processedRecords.map((r) => r.payload.batchId);
    const clientIds = processedRecords.map((r) => r.payload.clientId);
    const chunkIndexes = processedRecords.map((r) => r.payload.originalIndex);
    const contents = processedRecords.map((r) => r.processedContent);

    await this.databaseService.insertPlaceholderEmbeddings(contentHashes);
    await this.databaseService.insertChunksWithEnqueuedStatus(
      chunkIds,
      contentHashes,
      batchIds,
      clientIds,
      chunkIndexes,
      contents
    );

    logger.info(
      { recordCount: processedRecords.length },
      "Batch inserted chunks and placeholder embeddings"
    );
  }

  private async filterRecordsNeedingEmbeddings(
    processedRecords: RecordWithProcessedContent[]
  ): Promise<RecordWithProcessedContent[]> {
    logger.info(
      { contentHashes: processedRecords.map((r) => r.contentHash) },
      "Phase 2: Checking which embeddings need computation"
    );

    const contentHashes = processedRecords.map((r) => r.contentHash);
    const existingContentHashes =
      await this.databaseService.findExistingEmbeddings(contentHashes);

    const recordsNeedingEmbeddings = processedRecords.filter(
      (record) => !existingContentHashes.has(record.contentHash)
    );

    logger.info(
      {
        totalRecords: processedRecords.length,
        alreadyIngested: existingContentHashes.size,
        needProcessing: recordsNeedingEmbeddings.length,
      },
      "Processing status analysis"
    );

    return recordsNeedingEmbeddings;
  }

  private async generateEmbeddingsIfNeeded(
    recordsNeedingEmbeddings: RecordWithProcessedContent[]
  ): Promise<number[][] | null> {
    if (recordsNeedingEmbeddings.length === 0) {
      logger.info(
        { recordCount: recordsNeedingEmbeddings.length },
        "All embeddings already exist, skipping generation"
      );
      return null;
    }

    logger.info(
      {
        recordsToProcess: recordsNeedingEmbeddings.length,
      },
      "Phase 3: Generating embeddings for new content"
    );

    try {
      const contents = recordsNeedingEmbeddings.map(
        (record) => record.processedContent
      );
      const embeddings = await this.embeddingService.generateEmbeddingsBatch(
        contents
      );
      this.embeddingService.validateEmbeddingsBatch(
        embeddings,
        contents.length
      );

      logger.info(
        { generatedCount: embeddings.length },
        "Embeddings generated successfully"
      );

      return embeddings;
    } catch (embeddingError) {
      logger.error(
        { error: embeddingError, recordCount: recordsNeedingEmbeddings.length },
        "Embedding generation failed - marking chunks as FAILED"
      );

      await this.markChunksAsFailed(
        recordsNeedingEmbeddings,
        "COMPUTE_EMBEDDINGS_FAILURE"
      );

      throw embeddingError;
    }
  }

  private async updateDatabaseWithEmbeddingsAndStatus(
    processedRecords: RecordWithProcessedContent[],
    recordsNeedingEmbeddings: RecordWithProcessedContent[],
    embeddings: number[][] | null
  ): Promise<void> {
    logger.info(
      {
        recordCount: processedRecords.length,
        hasNewEmbeddings: embeddings !== null,
      },
      "Phase 4: Updating database"
    );

    try {
      if (embeddings && recordsNeedingEmbeddings.length > 0) {
        const contentHashes = recordsNeedingEmbeddings.map(
          (r) => r.contentHash
        );
        await this.databaseService.updateEmbeddingsWithGeneratedValues(
          contentHashes,
          embeddings
        );
        logger.info(
          { updatedEmbeddings: recordsNeedingEmbeddings.length },
          "Updated embeddings"
        );
      }

      const contentHashes = processedRecords.map((r) => r.contentHash);
      await this.databaseService.updateChunkStatusToIngested(contentHashes);
      logger.info(
        { updatedCount: contentHashes.length },
        "Batch updated chunk status to INGESTED"
      );
    } catch (dbError) {
      logger.error(
        { error: dbError, recordCount: processedRecords.length },
        "Database update failed - marking chunks as FAILED"
      );

      await this.markChunksAsFailed(processedRecords, "DATA_LAYER_FAILURE");
      throw dbError;
    }
  }

  private async markChunksAsFailed(
    records: RecordWithProcessedContent[],
    failureReason: string
  ): Promise<void> {
    const chunkIds = records.map((record) => record.chunkId);
    try {
      await this.databaseService.updateChunkStatusToFailed(
        chunkIds,
        failureReason
      );
    } catch (updateError) {
      logger.error({ error: updateError }, "Failed to update chunk status to FAILED");
    }
  }

  private createSuccessResults(
    processedRecords: RecordWithProcessedContent[]
  ): ProcessedRecord[] {
    return processedRecords.map((record) => ({
      messageId: record.messageId,
      payload: record.payload,
      success: true,
    }));
  }

  private createFailureResultsForAllRecords(
    records: Array<{ messageId: string; payload: Payload }>,
    error: unknown
  ): ProcessedRecord[] {
    return records.map((record) => ({
      messageId: record.messageId,
      payload: record.payload,
      success: false,
      error: error instanceof Error ? error.message : "Critical processing failure",
    }));
  }
}

export function createBatchProcessor(
  databaseService: DatabaseService,
  embeddingService: EmbeddingService
): BatchProcessor {
  return new BatchProcessor(databaseService, embeddingService);
}
