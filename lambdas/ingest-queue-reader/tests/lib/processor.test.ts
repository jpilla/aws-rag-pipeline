import { jest } from '@jest/globals';
import { BatchProcessor, createBatchProcessor, Payload } from "../../src/lib/processor";
import { DatabaseService } from "../../src/lib/services/database.service";
import { EmbeddingService } from "../../src/lib/services/embedding.service";

jest.mock("../../src/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

function makePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    chunkId: "chunk-1",
    clientId: "client-1",
    content: "test content",
    metadata: {},
    batchId: "batch-1",
    enqueuedAt: new Date().toISOString(),
    contentHash: "hash-1",
    originalIndex: 0,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<Payload> = {}) {
  return {
    messageId: "msg-1",
    payload: makePayload(overrides),
  };
}

import { describe, it, expect, beforeEach } from '@jest/globals';

describe("BatchProcessor", () => {
  let databaseService: jest.Mocked<DatabaseService>;
  let embeddingService: jest.Mocked<EmbeddingService>;
  let processor: BatchProcessor;

  beforeEach(() => {
    databaseService = {
      insertPlaceholderEmbeddings: jest.fn(),
      insertChunksWithEnqueuedStatus: jest.fn(),
      findExistingEmbeddings: jest.fn(),
      updateEmbeddingsWithGeneratedValues: jest.fn(),
      updateChunkStatusToIngested: jest.fn(),
      updateChunkStatusToFailed: jest.fn(),
    };

    embeddingService = {
      generateEmbeddingsBatch: jest.fn(),
      validateEmbeddingsBatch: jest.fn(),
    };

    processor = createBatchProcessor(databaseService, embeddingService);
  });

  describe("processBatch", () => {
    it("whenAllRecordsSucceed_processesAndReturnsSuccessResults", async () => {
      const records = [makeRecord(), makeRecord({ contentHash: "hash-2" })];

      databaseService.findExistingEmbeddings.mockResolvedValue(new Set());
      embeddingService.generateEmbeddingsBatch.mockResolvedValue([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(databaseService.insertPlaceholderEmbeddings).toHaveBeenCalled();
      expect(databaseService.insertChunksWithEnqueuedStatus).toHaveBeenCalled();
      expect(embeddingService.generateEmbeddingsBatch).toHaveBeenCalled();
      expect(databaseService.updateEmbeddingsWithGeneratedValues).toHaveBeenCalled();
      expect(databaseService.updateChunkStatusToIngested).toHaveBeenCalled();
    });

    it("whenEmbeddingsAlreadyExist_skipsGenerationAndStillSucceeds", async () => {
      const records = [makeRecord()];
      const existingHashes = new Set(["hash-1"]);

      databaseService.findExistingEmbeddings.mockResolvedValue(existingHashes);

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(embeddingService.generateEmbeddingsBatch).not.toHaveBeenCalled();
      expect(databaseService.updateEmbeddingsWithGeneratedValues).not.toHaveBeenCalled();
      expect(databaseService.updateChunkStatusToIngested).toHaveBeenCalled();
    });

    it("whenEmbeddingGenerationFails_marksChunksAsFailedAndReturnsErrors", async () => {
      const records = [makeRecord()];

      databaseService.findExistingEmbeddings.mockResolvedValue(new Set());
      embeddingService.generateEmbeddingsBatch.mockRejectedValue(
        new Error("OpenAI API error")
      );

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("OpenAI API error");
      expect(databaseService.updateChunkStatusToFailed).toHaveBeenCalledWith(
        ["chunk-1"],
        "COMPUTE_EMBEDDINGS_FAILURE"
      );
    });

    it("whenDatabaseUpdateFails_marksChunksAsFailedAndReturnsErrors", async () => {
      const records = [makeRecord()];

      databaseService.findExistingEmbeddings.mockResolvedValue(new Set());
      embeddingService.generateEmbeddingsBatch.mockResolvedValue([
        [0.1, 0.2, 0.3],
      ]);
      databaseService.updateChunkStatusToIngested.mockRejectedValue(
        new Error("Database connection lost")
      );

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("Database connection lost");
      expect(databaseService.updateChunkStatusToFailed).toHaveBeenCalledWith(
        ["chunk-1"],
        "DATA_LAYER_FAILURE"
      );
    });

    it("whenContentIsObject_convertsToStringBeforeProcessing", async () => {
      const records = [
        makeRecord({
          content: { key: "value" },
          contentHash: "hash-object",
        }),
      ];

      databaseService.findExistingEmbeddings.mockResolvedValue(new Set());
      embeddingService.generateEmbeddingsBatch.mockResolvedValue([
        [0.1, 0.2, 0.3],
      ]);

      await processor.processBatch(records);

      const callArgs = embeddingService.generateEmbeddingsBatch.mock.calls[0][0];
      expect(callArgs[0]).toBe('{"key":"value"}');
    });

    it("whenMultipleRecords_processesAllInBatch", async () => {
      const records = [
        makeRecord({ contentHash: "hash-1" }),
        makeRecord({ contentHash: "hash-2" }),
        makeRecord({ contentHash: "hash-3" }),
      ];

      databaseService.findExistingEmbeddings.mockResolvedValue(new Set());
      embeddingService.generateEmbeddingsBatch.mockResolvedValue([
        [0.1, 0.2],
        [0.3, 0.4],
        [0.5, 0.6],
      ]);

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(3);
      expect(embeddingService.generateEmbeddingsBatch).toHaveBeenCalledWith([
        "test content",
        "test content",
        "test content",
      ]);
    });

    it("whenPartialEmbeddingsExist_onlyGeneratesMissingOnes", async () => {
      const records = [
        makeRecord({ contentHash: "hash-1" }),
        makeRecord({ contentHash: "hash-2" }),
      ];

      databaseService.findExistingEmbeddings.mockResolvedValue(
        new Set(["hash-1"])
      );
      embeddingService.generateEmbeddingsBatch.mockResolvedValue([
        [0.1, 0.2, 0.3],
      ]);

      await processor.processBatch(records);

      expect(embeddingService.generateEmbeddingsBatch).toHaveBeenCalledTimes(1);
      expect(embeddingService.generateEmbeddingsBatch).toHaveBeenCalledWith([
        "test content",
      ]);
    });

    it("whenCriticalErrorOccurs_marksAllRecordsAsFailed", async () => {
      const records = [makeRecord(), makeRecord({ contentHash: "hash-2" })];

      databaseService.insertPlaceholderEmbeddings.mockRejectedValue(
        new Error("Critical database failure")
      );

      const results = await processor.processBatch(records);

      expect(results).toHaveLength(2);
      expect(results.every((r) => !r.success)).toBe(true);
      expect(results.every((r) => r.error)).toBe(true);
    });
  });
});
