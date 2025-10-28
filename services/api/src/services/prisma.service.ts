import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

/**
 * Service for managing Prisma database operations
 */
export class PrismaService {
  private client?: PrismaClient;

  constructor() {
    // Initialize Prisma client lazily
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

      const databaseUrl = `postgresql://${username}:${password}@${host}:${port}/${database}?sslmode=require`;

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
      await client.$queryRaw`SELECT 1`;
      return {
        success: true,
        message: 'Prisma database connection successful',
      };
    } catch (error: any) {
      logger.error({ error }, "Prisma connection test failed");
      return {
        success: false,
        message: error.message || 'Prisma database connection failed',
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
  ): Promise<{ success: boolean; embeddings: any[]; count: number; error?: string }> {
    try {
      const client = await this.getClient();

      // Use raw SQL for vector similarity search with pgvector
      // Convert the array to a string format that PostgreSQL can understand
      const embeddingString = `[${queryEmbedding.join(',')}]`;

      // Use cosine distance (<=>) which is better for similarity search
      // Cosine distance ranges from 0 (identical) to 2 (opposite)
      // Convert threshold to cosine distance: similarity = 1 - (distance/2)
      const cosineThreshold = 2 - (threshold * 2); // Convert similarity to distance

      const embeddings = await client.$queryRaw`
        SELECT c.id, c."batchId" as "docId", c."chunkIndex", c.content,
               (e.embedding <=> ${embeddingString}::vector) as distance
        FROM "Embedding" e
        JOIN "Chunk" c ON e."contentHash" = c."contentHash"
        WHERE (e.embedding <=> ${embeddingString}::vector) < ${cosineThreshold}
        ORDER BY e.embedding <=> ${embeddingString}::vector
        LIMIT ${limit}
      `;

      return {
        success: true,
        embeddings: embeddings as any[],
        count: (embeddings as any[]).length
      };
    } catch (error: any) {
      logger.error({ error }, "Vector similarity search failed");
      return {
        success: false,
        embeddings: [],
        count: 0,
        error: error.message || "Failed to perform similarity search"
      };
    }
  }

  /**
   * Get embeddings by batchId with status information
   */
  async getEmbeddingsByBatchId(batchId: string): Promise<{
    success: boolean;
    embeddings: any[];
    count: number;
    error?: string
  }> {
    try {
      const client = await this.getClient();

      const embeddings = await client.$queryRaw`
        SELECT c.id, c."batchId", c."clientId", c."chunkIndex", c.content,
               CASE
                 WHEN e.embedding IS NOT NULL THEN 'INGESTED'
                 WHEN c.status = 'FAILED' THEN 'FAILED'
                 ELSE 'ENQUEUED'
               END as status,
               c."failureReason",
               c."createdAt", c."updatedAt"
        FROM "Chunk" c
        LEFT JOIN "Embedding" e ON c."contentHash" = e."contentHash"
        WHERE c."batchId" = ${batchId}
        ORDER BY c."chunkIndex"
      `;

      return {
        success: true,
        embeddings: embeddings as any[],
        count: (embeddings as any[]).length
      };
    } catch (error: any) {
      logger.error({ error }, "Batch embeddings retrieval failed");
      return {
        success: false,
        embeddings: [],
        count: 0,
        error: error.message || "Failed to retrieve batch embeddings"
      };
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

      const result = await client.$queryRaw`
        SELECT
          COUNT(*) as total_chunks,
          COUNT(CASE WHEN e.embedding IS NOT NULL THEN 1 END) as ingested_chunks,
          COUNT(CASE WHEN c.status = 'FAILED' THEN 1 END) as failed_chunks,
          COUNT(CASE WHEN e.embedding IS NULL AND c.status != 'FAILED' THEN 1 END) as enqueued_chunks,
          MIN(c."createdAt") as created_at,
          MAX(CASE WHEN e.embedding IS NOT NULL OR c.status = 'FAILED' THEN c."updatedAt" END) as completed_at
        FROM "Chunk" c
        LEFT JOIN "Embedding" e ON c."contentHash" = e."contentHash"
        WHERE c."batchId" = ${batchId}
      `;

      const stats = (result as any[])[0];

      return {
        success: true,
        batchId,
        totalChunks: parseInt(stats.total_chunks),
        enqueuedChunks: parseInt(stats.enqueued_chunks),
        ingestedChunks: parseInt(stats.ingested_chunks),
        failedChunks: parseInt(stats.failed_chunks),
        createdAt: stats.created_at,
        completedAt: stats.completed_at
      };
    } catch (error: any) {
      logger.error({ error }, "Batch status retrieval failed");
      return {
        success: false,
        batchId,
        totalChunks: 0,
        enqueuedChunks: 0,
        ingestedChunks: 0,
        failedChunks: 0,
        error: error.message || "Failed to retrieve batch status"
      };
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

      await client.$executeRaw`
        INSERT INTO "IdempotencyKey" ("idempotencyKey", "batchId", "createdAt")
        VALUES (${idempotencyKey}, ${batchId}, NOW())
        ON CONFLICT ("idempotencyKey") DO NOTHING
      `;

      return { success: true };
    } catch (error: any) {
      logger.error({ error }, "Failed to store idempotency key");
      return {
        success: false,
        error: error.message || "Failed to store idempotency key"
      };
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

      const result = await client.$queryRaw<Array<{ batchId: string }>>`
        SELECT "batchId" FROM "IdempotencyKey"
        WHERE "idempotencyKey" = ${idempotencyKey}
        LIMIT 1
      `;

      if (result.length === 0) {
        return { success: true };
      }

      return {
        success: true,
        batchId: result[0].batchId
      };
    } catch (error: any) {
      logger.error({ error }, "Failed to get batch by idempotency key");
      return {
        success: false,
        error: error.message || "Failed to get batch by idempotency key"
      };
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

}

// Export a singleton instance
export const prismaService = new PrismaService();
