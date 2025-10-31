import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { SqlQueries } from './queries/sql.queries';
import {
  SimilarEmbeddingRow,
  ChunkWithStatusRow,
  BatchStatusRow,
  BatchIdRow
} from '../types/database.types';

/**
 * Service interface for Prisma client operations
 */
export interface PrismaClientService {
  getClient(): Promise<PrismaClient>;
}

/**
 * Service interface for SQL query operations
 */
export interface SqlQueryService {
  executeHealthCheck(client: PrismaClient): Promise<void>;
  findSimilarEmbeddings(client: PrismaClient, embeddingString: string, cosineThreshold: number, limit: number): Promise<SimilarEmbeddingRow[]>;
  getChunksByBatchId(client: PrismaClient, batchId: string): Promise<ChunkWithStatusRow[]>;
  getBatchStatus(client: PrismaClient, batchId: string): Promise<BatchStatusRow[]>;
  storeIdempotencyKey(client: PrismaClient, idempotencyKey: string, batchId: string): Promise<void>;
  getBatchByKey(client: PrismaClient, idempotencyKey: string): Promise<BatchIdRow[]>;
}

/**
 * Service for managing Prisma database operations
 */
export class PrismaService {
  private client?: PrismaClient;
  private sqlQueries: SqlQueryService;

  constructor(sqlQueries?: SqlQueryService) {
    // Initialize Prisma client lazily
    this.sqlQueries = sqlQueries || new SqlQueries();
  }

  /**
   * Get the Prisma client, initializing it if necessary
   */
  async getClient(): Promise<PrismaClient> {
    if (!this.client) {
      // Construct DATABASE_URL from environment variables
      const host = process.env.DB_HOST || 'localhost';
      const port = process.env.DB_PORT || '5432';
      const database = process.env.DB_NAME || 'embeddings';
      const username = process.env.DB_USER;
      const password = process.env.DB_PASSWORD;

      if (!username || !password) {
        throw new Error('DB_USER and DB_PASSWORD environment variables are required');
      }

      // SSL mode: require for production (AWS RDS), disable for local development
      const sslMode = process.env.DB_SSLMODE || 'require';
      const databaseUrl = `postgresql://${username}:${password}@${host}:${port}/${database}?sslmode=${sslMode}`;

      this.client = new PrismaClient({
        datasources: {
          db: {
            url: databaseUrl,
          },
        },
        log: ['error', 'warn'],
      });

      logger.info({ host, port, database }, "Prisma client initialized");
    }

    return this.client;
  }

  /**
   * Test database connectivity
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const client = await this.getClient();
      await this.sqlQueries.executeHealthCheck(client);
      return {
        success: true,
        message: 'Prisma database connection successful',
      };
    } catch (error: unknown) {
      logger.error({ error }, "Prisma connection test failed");
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Prisma database connection failed',
      };
    }
  }

  /**
   * Validate embedding data structure
   */
  validateEmbedding(embedding: any): { isValid: boolean; error?: string } {
    if (!embedding.id || typeof embedding.id !== 'string') {
      return { isValid: false, error: "Each embedding must have a valid id (string)" };
    }
    if (typeof embedding.chunkIndex !== 'number') {
      return { isValid: false, error: "Each embedding must have a valid chunkIndex (number)" };
    }
    if (!embedding.content || typeof embedding.content !== 'string') {
      return { isValid: false, error: "Each embedding must have valid content (string)" };
    }
    if (!Array.isArray(embedding.embedding) || embedding.embedding.length === 0) {
      return { isValid: false, error: "Each embedding must have a valid embedding array" };
    }
    return { isValid: true };
  }

  /**
   * Validate embeddings data
   */
  validateEmbeddings(embeddings: any[]): { isValid: boolean; error?: string } {
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      return { isValid: false, error: "embeddings array is required and must not be empty" };
    }

    for (const embedding of embeddings) {
      const validation = this.validateEmbedding(embedding);
      if (!validation.isValid) {
        return validation;
      }
    }

    return { isValid: true };
  }


  /**
   * Find similar embeddings using vector similarity search with pgvector
   */
  async findSimilarEmbeddings(
    queryEmbedding: number[],
    limit: number = 5,
    threshold: number = 0.7
  ): Promise<{ success: boolean; embeddings: SimilarEmbeddingRow[]; count: number; error?: string }> {
    try {
      const client = await this.getClient();
      const embeddingString = this.formatEmbeddingForSql(queryEmbedding);
      const cosineThreshold = this.convertThresholdToCosineDistance(threshold);
      const embeddings = await this.sqlQueries.findSimilarEmbeddings(client, embeddingString, cosineThreshold, limit);
      return this.createSearchSuccessResponse(embeddings);
    } catch (error: unknown) {
      return this.createSearchErrorResponse(error);
    }
  }

  /**
   * Get chunks by batchId with status information
   */
  async getChunksByBatchId(batchId: string): Promise<{
    success: boolean;
    chunks: ChunkWithStatusRow[];
    count: number;
    error?: string
  }> {
    try {
      const client = await this.getClient();
      const chunks = await this.sqlQueries.getChunksByBatchId(client, batchId);
      return this.createChunksSuccessResponse(chunks);
    } catch (error: unknown) {
      return this.createChunksErrorResponse(error);
    }
  }

  /**
   * Get batch status summary
   */
  async getBatchStatus(batchId: string): Promise<{
    success: boolean;
    batchId: string;
    totalChunks: number;
    enqueuedChunks: number;
    ingestedChunks: number;
    failedChunks: number;
    createdAt?: string;
    completedAt?: string;
    error?: string
  }> {
    try {
      const client = await this.getClient();
      const result = await this.sqlQueries.getBatchStatus(client, batchId);
      return this.createBatchStatusSuccessResponse(batchId, result);
    } catch (error: unknown) {
      return this.createBatchStatusErrorResponse(batchId, error);
    }
  }

  /**
   * Store idempotency key mapping
   */
  async storeIdempotencyKey(
    idempotencyKey: string,
    batchId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      await this.sqlQueries.storeIdempotencyKey(client, idempotencyKey, batchId);
      return { success: true };
    } catch (error: unknown) {
      return this.createStoreIdempotencyErrorResponse(error);
    }
  }

  /**
   * Get batch ID by idempotency key
   */
  async getBatchByKey(
    idempotencyKey: string
  ): Promise<{ success: boolean; batchId?: string; error?: string }> {
    try {
      const client = await this.getClient();
      const result = await this.sqlQueries.getBatchByKey(client, idempotencyKey);
      return this.createGetBatchByKeyResponse(result);
    } catch (error: unknown) {
      return this.createGetBatchByKeyErrorResponse(error);
    }
  }

  /**
   * Close the Prisma client connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
      this.client = undefined;
      logger.info('Prisma client disconnected');
    }
  }

  // ============= Private Helper Methods =============

  /**
   * Format embedding array for SQL vector query
   */
  private formatEmbeddingForSql(queryEmbedding: number[]): string {
    return `[${queryEmbedding.join(',')}]`;
  }

  /**
   * Convert similarity threshold to cosine distance
   * Cosine distance ranges from 0 (identical) to 2 (opposite)
   * Similarity = 1 - (distance/2)
   */
  private convertThresholdToCosineDistance(threshold: number): number {
    return 2 - (threshold * 2);
  }

  /**
   * Create success response for search results
   */
  private createSearchSuccessResponse(embeddings: SimilarEmbeddingRow[]): { success: boolean; embeddings: SimilarEmbeddingRow[]; count: number } {
    return {
      success: true,
      embeddings,
      count: embeddings.length
    };
  }

  /**
   * Create error response for search failures
   */
  private createSearchErrorResponse(error: unknown): { success: boolean; embeddings: SimilarEmbeddingRow[]; count: number; error: string } {
    logger.error({ error }, "Vector similarity search failed");
    return {
      success: false,
      embeddings: [],
      count: 0,
      error: error instanceof Error ? error.message : "Failed to perform similarity search"
    };
  }

  /**
   * Create success response for chunks query
   */
  private createChunksSuccessResponse(chunks: ChunkWithStatusRow[]): { success: boolean; chunks: ChunkWithStatusRow[]; count: number } {
    return {
      success: true,
      chunks,
      count: chunks.length
    };
  }

  /**
   * Create error response for chunks query failures
   */
  private createChunksErrorResponse(error: unknown): { success: boolean; chunks: ChunkWithStatusRow[]; count: number; error: string } {
    logger.error({ error }, "Batch chunks retrieval failed");
    return {
      success: false,
      chunks: [],
      count: 0,
      error: error instanceof Error ? error.message : "Failed to retrieve batch chunks"
    };
  }

  /**
   * Create success response for batch status query
   */
  private createBatchStatusSuccessResponse(batchId: string, result: BatchStatusRow[]): {
    success: boolean;
    batchId: string;
    totalChunks: number;
    enqueuedChunks: number;
    ingestedChunks: number;
    failedChunks: number;
    createdAt?: string;
    completedAt?: string;
  } {
    const stats = result[0];
    return {
      success: true,
      batchId,
      totalChunks: parseInt(stats.total_chunks),
      enqueuedChunks: parseInt(stats.enqueued_chunks),
      ingestedChunks: parseInt(stats.ingested_chunks),
      failedChunks: parseInt(stats.failed_chunks),
      createdAt: stats.created_at ? stats.created_at.toISOString() : undefined,
      completedAt: stats.completed_at ? stats.completed_at.toISOString() : undefined
    };
  }

  /**
   * Create error response for batch status query failures
   */
  private createBatchStatusErrorResponse(batchId: string, error: unknown): {
    success: boolean;
    batchId: string;
    totalChunks: number;
    enqueuedChunks: number;
    ingestedChunks: number;
    failedChunks: number;
    error: string;
  } {
    logger.error({ error }, "Batch status retrieval failed");
    return {
      success: false,
      batchId,
      totalChunks: 0,
      enqueuedChunks: 0,
      ingestedChunks: 0,
      failedChunks: 0,
      error: error instanceof Error ? error.message : "Failed to retrieve batch status"
    };
  }

  /**
   * Create error response for storing idempotency key failures
   */
  private createStoreIdempotencyErrorResponse(error: unknown): { success: boolean; error: string } {
    logger.error({ error }, "Failed to store idempotency key");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to store idempotency key"
    };
  }

  /**
   * Create response for get batch by key query
   */
  private createGetBatchByKeyResponse(result: BatchIdRow[]): { success: boolean; batchId?: string } {
    if (result.length === 0) {
      return { success: true };
    }
    return {
      success: true,
      batchId: result[0].batchId
    };
  }

  /**
   * Create error response for get batch by key failures
   */
  private createGetBatchByKeyErrorResponse(error: unknown): { success: boolean; error: string } {
    logger.error({ error }, "Failed to get batch by idempotency key");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get batch by idempotency key"
    };
  }
}

/**
 * Factory function to create PrismaService with injected dependencies
 * Dependencies should be created outside and injected for better testability
 */
export function createPrismaService(sqlQueries?: SqlQueryService): PrismaService {
  return new PrismaService(sqlQueries);
}

// Export a singleton instance
export const prismaService = new PrismaService();
