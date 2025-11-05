import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock("../../src/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));


import { SQSHandlerService } from "../../src/handler";
import { BatchProcessor, Payload } from "../../src/lib/processor";
import { ClientInitializationService } from "../../src/lib/services/client-initialization.service";
import { DatabaseService } from "../../src/lib/services/database.service";
import { EmbeddingService } from "../../src/lib/services/embedding.service";

function makePayload(overrides: Partial<Payload> = {}): Payload {
  return {
    chunkId: "chunk-1",
    clientId: "client-1",
    content: "test content",
    metadata: { requestId: "req-1" },
    batchId: "batch-1",
    enqueuedAt: new Date().toISOString(),
    contentHash: "hash-1",
    originalIndex: 0,
    ...overrides,
  };
}

function makeSQSRecord(overrides: Partial<Payload> = {}) {
  return {
    messageId: "msg-1",
    body: JSON.stringify(makePayload(overrides)),
  };
}

describe("SQSHandlerService", () => {
  let clientInitializationService: jest.Mocked<ClientInitializationService>;
  let mockDatabaseService: jest.Mocked<DatabaseService>;
  let mockEmbeddingService: jest.Mocked<EmbeddingService>;
  let mockBatchProcessor: jest.Mocked<BatchProcessor>;
  let handlerService: SQSHandlerService;

  beforeEach(() => {
    clientInitializationService = {
      initializePrismaClient: jest.fn<() => Promise<any>>().mockResolvedValue({} as any),
      initializeOpenAIClient: jest.fn<() => Promise<any>>().mockResolvedValue({} as any),
      closeClients: jest.fn(),
    };

    mockDatabaseService = {
      insertPlaceholderEmbeddings: jest.fn(),
      insertChunksWithEnqueuedStatus: jest.fn(),
      findExistingEmbeddings: jest.fn(),
      updateEmbeddingsWithGeneratedValues: jest.fn(),
      updateChunkStatusToIngested: jest.fn(),
      updateChunkStatusToFailed: jest.fn(),
    };

    mockEmbeddingService = {
      generateEmbeddingsBatch: jest.fn(),
      validateEmbeddingsBatch: jest.fn(),
    };

    mockBatchProcessor = {
      processBatch: jest.fn(),
    } as any;

    const createBatchProcessorFn = () => mockBatchProcessor;

    handlerService = new SQSHandlerService(
      clientInitializationService,
      createBatchProcessorFn as any
    );
  });

  describe("handle", () => {
    it("whenAllRecordsValid_processesSuccessfully", async () => {
      const event = {
        Records: [makeSQSRecord(), makeSQSRecord({ contentHash: "hash-2" })],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: true },
        {
          messageId: "msg-2",
          payload: makePayload({ contentHash: "hash-2" }),
          success: true,
        },
      ]);

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockBatchProcessor.processBatch).toHaveBeenCalled();
    });

    it("whenSomeRecordsInvalid_addsInvalidRecordsToFailures", async () => {
      const event = {
        Records: [
          makeSQSRecord(),
          { messageId: "msg-2", body: "invalid json" },
        ],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: true },
      ]);

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(1);
      expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-2");
    });

    it("whenProcessingFails_marksAllRecordsAsFailed", async () => {
      const event = {
        Records: [makeSQSRecord(), makeSQSRecord({ contentHash: "hash-2" })],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: false },
        {
          messageId: "msg-2",
          payload: makePayload({ contentHash: "hash-2" }),
          success: false,
        },
      ]);

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(2);
    });

    it("whenProcessingThrows_rejectsAllRecords", async () => {
      const event = {
        Records: [makeSQSRecord(), makeSQSRecord({ contentHash: "hash-2" })],
      };

      mockBatchProcessor.processBatch.mockRejectedValue(
        new Error("Processing failed")
      );

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(2);
    });

    it("whenClientInitializationFails_rejectsAllRecords", async () => {
      const event = {
        Records: [makeSQSRecord()],
      };

      clientInitializationService.initializePrismaClient.mockRejectedValue(
        new Error("Database connection failed")
      );

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(1);
    });

    it("whenMixedSuccessAndFailure_returnsCorrectFailures", async () => {
      const event = {
        Records: [
          makeSQSRecord(),
          makeSQSRecord({ contentHash: "hash-2" }),
          { messageId: "msg-3", body: "invalid" },
        ],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: true },
        {
          messageId: "msg-2",
          payload: makePayload({ contentHash: "hash-2" }),
          success: false,
        },
      ]);

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(2);
      expect(
        result.batchItemFailures.find((f) => f.itemIdentifier === "msg-2")
      ).toBeDefined();
      expect(
        result.batchItemFailures.find((f) => f.itemIdentifier === "msg-3")
      ).toBeDefined();
    });

    it("whenExtractingRequestIds_handlesMissingMetadata", async () => {
      const event = {
        Records: [
          makeSQSRecord({ metadata: { requestId: "req-1" } }),
          makeSQSRecord({ metadata: {} }),
          { messageId: "msg-3", body: "invalid" },
        ],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: true },
      ]);

      const result = await handlerService.handle(event);

      expect(result.batchItemFailures).toHaveLength(1);
    });

    it("whenInitializedOnce_reusesBatchProcessor", async () => {
      const event = {
        Records: [makeSQSRecord()],
      };

      mockBatchProcessor.processBatch.mockResolvedValue([
        { messageId: "msg-1", payload: makePayload(), success: true },
      ]);

      await handlerService.handle(event);
      await handlerService.handle(event);

      expect(clientInitializationService.initializePrismaClient).toHaveBeenCalledTimes(1);
      expect(clientInitializationService.initializeOpenAIClient).toHaveBeenCalledTimes(1);
      expect(mockBatchProcessor.processBatch).toHaveBeenCalledTimes(2);
    });
  });
});
