import { PrismaService, createPrismaService, SqlQueryService, EnvVarCredentialProvider } from '../src/index';
import { PrismaClient } from '@prisma/client';

jest.mock('pino', () => ({
  default: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('PrismaService', () => {
  let mockClient: jest.Mocked<PrismaClient>;
  let mockSqlQueries: jest.Mocked<SqlQueryService>;
  let service: PrismaService;
  let mockCredentialProvider: jest.Mocked<EnvVarCredentialProvider>;

  beforeEach(() => {
    mockClient = {} as any;
    mockSqlQueries = {
      executeHealthCheck: jest.fn(),
      findSimilarEmbeddings: jest.fn(),
      getChunksByBatchId: jest.fn(),
      getBatchStatus: jest.fn(),
      storeIdempotencyKey: jest.fn(),
      getBatchByKey: jest.fn(),
      insertPlaceholderEmbeddings: jest.fn(),
      insertChunks: jest.fn(),
      getExistingEmbeddings: jest.fn(),
      updateEmbeddings: jest.fn(),
      updateChunksToIngested: jest.fn(),
      updateChunksToFailed: jest.fn(),
    };

    mockCredentialProvider = {
      getCredentials: jest.fn().mockResolvedValue({ username: 'test', password: 'test' }),
    } as any;

    // Mock getClient to return our mock client
    service = createPrismaService(mockCredentialProvider, mockSqlQueries);
    jest.spyOn(service, 'getClient' as any).mockResolvedValue(mockClient);
  });

  describe('testConnection', () => {
    it('whenConnectionSucceeds_returnsSuccessResponse', async () => {
      mockSqlQueries.executeHealthCheck.mockResolvedValue();

      const result = await service.testConnection();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Prisma database connection successful');
      expect(mockSqlQueries.executeHealthCheck).toHaveBeenCalledWith(mockClient);
    });

    it('whenConnectionFails_returnsFailureResponse', async () => {
      mockSqlQueries.executeHealthCheck.mockRejectedValue(new Error('Connection failed'));

      const result = await service.testConnection();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection failed');
    });
  });

  describe('findSimilarEmbeddings', () => {
    it('whenEmbeddingsFound_returnsSuccessResponse', async () => {
      const mockEmbeddings = [
        { id: '1', docId: 'b_123', chunkIndex: 0, content: 'test', distance: 0.5 },
        { id: '2', docId: 'b_123', chunkIndex: 1, content: 'test2', distance: 0.7 }
      ];
      mockSqlQueries.findSimilarEmbeddings.mockResolvedValue(mockEmbeddings);

      const result = await service.findSimilarEmbeddings([1, 2, 3], 5, 0.7);

      expect(result.success).toBe(true);
      expect(result.embeddings).toEqual(mockEmbeddings);
      expect(result.count).toBe(2);
      expect(mockSqlQueries.findSimilarEmbeddings).toHaveBeenCalledWith(
        mockClient,
        '[1,2,3]',
        expect.closeTo(0.6, 10),
        5
      );
    });

    it('whenSearchFails_returnsErrorResponse', async () => {
      mockSqlQueries.findSimilarEmbeddings.mockRejectedValue(new Error('Search failed'));

      const result = await service.findSimilarEmbeddings([1, 2, 3], 5, 0.7);

      expect(result.success).toBe(false);
      expect(result.embeddings).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe('Search failed');
    });

    it('whenThresholdConverted_calculatesCorrectCosineDistance', async () => {
      mockSqlQueries.findSimilarEmbeddings.mockResolvedValue([]);

      await service.findSimilarEmbeddings([1, 2, 3], 5, 0.8);

      expect(mockSqlQueries.findSimilarEmbeddings).toHaveBeenCalledWith(
        mockClient,
        '[1,2,3]',
        expect.closeTo(0.4, 10), // 2 - (0.8 * 2) = 0.4
        5
      );
    });
  });

  describe('getChunksByBatchId', () => {
    it('whenChunksFound_returnsSuccessResponse', async () => {
      const mockChunks = [
        { id: 'c_1', batchId: 'b_123', clientId: 'client1', chunkIndex: 0, content: 'test1', status: 'INGESTED' as const, failureReason: null, createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01') },
        { id: 'c_2', batchId: 'b_123', clientId: 'client2', chunkIndex: 1, content: 'test2', status: 'ENQUEUED' as const, failureReason: null, createdAt: new Date('2024-01-02'), updatedAt: new Date('2024-01-02') }
      ];
      mockSqlQueries.getChunksByBatchId.mockResolvedValue(mockChunks);

      const result = await service.getChunksByBatchId('b_123');

      expect(result.success).toBe(true);
      expect(result.chunks).toEqual(mockChunks);
      expect(result.count).toBe(2);
      expect(mockSqlQueries.getChunksByBatchId).toHaveBeenCalledWith(mockClient, 'b_123');
    });

    it('whenQueryFails_returnsErrorResponse', async () => {
      mockSqlQueries.getChunksByBatchId.mockRejectedValue(new Error('Query failed'));

      const result = await service.getChunksByBatchId('b_123');

      expect(result.success).toBe(false);
      expect(result.chunks).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('getBatchStatus', () => {
    it('whenStatusFound_returnsSuccessResponse', async () => {
      const mockStats = [{
        total_chunks: '10',
        ingested_chunks: '7',
        failed_chunks: '1',
        enqueued_chunks: '2',
        created_at: new Date('2024-01-01T00:00:00Z'),
        completed_at: new Date('2024-01-02T00:00:00Z')
      }];
      mockSqlQueries.getBatchStatus.mockResolvedValue(mockStats);

      const result = await service.getBatchStatus('b_123');

      expect(result.success).toBe(true);
      expect(result.batchId).toBe('b_123');
      expect(result.totalChunks).toBe(10);
      expect(result.ingestedChunks).toBe(7);
      expect(result.failedChunks).toBe(1);
      expect(result.enqueuedChunks).toBe(2);
      expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.completedAt).toBe('2024-01-02T00:00:00.000Z');
    });

    it('whenQueryFails_returnsErrorResponse', async () => {
      mockSqlQueries.getBatchStatus.mockRejectedValue(new Error('Query failed'));

      const result = await service.getBatchStatus('b_123');

      expect(result.success).toBe(false);
      expect(result.batchId).toBe('b_123');
      expect(result.totalChunks).toBe(0);
      expect(result.ingestedChunks).toBe(0);
      expect(result.failedChunks).toBe(0);
      expect(result.enqueuedChunks).toBe(0);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('storeIdempotencyKey', () => {
    it('whenStorageSucceeds_returnsSuccessResponse', async () => {
      mockSqlQueries.storeIdempotencyKey.mockResolvedValue();

      const result = await service.storeIdempotencyKey('idem-key', 'b_123');

      expect(result.success).toBe(true);
      expect(mockSqlQueries.storeIdempotencyKey).toHaveBeenCalledWith(mockClient, 'idem-key', 'b_123');
    });

    it('whenStorageFails_returnsErrorResponse', async () => {
      mockSqlQueries.storeIdempotencyKey.mockRejectedValue(new Error('Storage failed'));

      const result = await service.storeIdempotencyKey('idem-key', 'b_123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Storage failed');
    });
  });

  describe('getBatchByKey', () => {
    it('whenBatchFound_returnsSuccessResponseWithBatchId', async () => {
      mockSqlQueries.getBatchByKey.mockResolvedValue([{ batchId: 'b_123' }]);

      const result = await service.getBatchByKey('idem-key');

      expect(result.success).toBe(true);
      expect(result.batchId).toBe('b_123');
      expect(mockSqlQueries.getBatchByKey).toHaveBeenCalledWith(mockClient, 'idem-key');
    });

    it('whenBatchNotFound_returnsSuccessResponseWithoutBatchId', async () => {
      mockSqlQueries.getBatchByKey.mockResolvedValue([]);

      const result = await service.getBatchByKey('idem-key');

      expect(result.success).toBe(true);
      expect(result.batchId).toBeUndefined();
    });

    it('whenQueryFails_returnsErrorResponse', async () => {
      mockSqlQueries.getBatchByKey.mockRejectedValue(new Error('Query failed'));

      const result = await service.getBatchByKey('idem-key');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Query failed');
    });
  });

  describe('validateEmbedding', () => {
    it('whenValidEmbedding_returnsValid', () => {
      const embedding = {
        id: 'test-id',
        chunkIndex: 0,
        content: 'test content',
        embedding: [0.1, 0.2, 0.3]
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(true);
    });

    it('whenMissingId_returnsInvalid', () => {
      const embedding = {
        chunkIndex: 0,
        content: 'test content',
        embedding: [0.1, 0.2, 0.3]
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid id (string)');
    });

    it('whenMissingChunkIndex_returnsInvalid', () => {
      const embedding = {
        id: 'test-id',
        content: 'test content',
        embedding: [0.1, 0.2, 0.3]
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid chunkIndex (number)');
    });

    it('whenMissingContent_returnsInvalid', () => {
      const embedding = {
        id: 'test-id',
        chunkIndex: 0,
        embedding: [0.1, 0.2, 0.3]
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid content (string)');
    });

    it('whenMissingEmbedding_returnsInvalid', () => {
      const embedding = {
        id: 'test-id',
        chunkIndex: 0,
        content: 'test content'
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid embedding array');
    });

    it('whenEmptyEmbedding_returnsInvalid', () => {
      const embedding = {
        id: 'test-id',
        chunkIndex: 0,
        content: 'test content',
        embedding: []
      };

      const result = service.validateEmbedding(embedding);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid embedding array');
    });
  });

  describe('validateEmbeddings', () => {
    it('whenAllValid_returnsValid', () => {
      const embeddings = [
        { id: '1', chunkIndex: 0, content: 'test1', embedding: [0.1] },
        { id: '2', chunkIndex: 1, content: 'test2', embedding: [0.2] }
      ];

      const result = service.validateEmbeddings(embeddings);

      expect(result.isValid).toBe(true);
    });

    it('whenEmptyArray_returnsInvalid', () => {
      const result = service.validateEmbeddings([]);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('must not be empty');
    });

    it('whenOneInvalid_returnsInvalid', () => {
      const embeddings = [
        { id: '1', chunkIndex: 0, content: 'test1', embedding: [0.1] },
        { id: '2', content: 'test2', embedding: [0.2] } // missing chunkIndex
      ];

      const result = service.validateEmbeddings(embeddings);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('valid chunkIndex (number)');
    });
  });
});
