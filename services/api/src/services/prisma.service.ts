import { PrismaClient } from '@prisma/client';

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

      console.log(`Prisma client initialized: ${host}:${port}/${database}`);
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
      console.error('Prisma connection test failed:', error);
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
   * Create or update multiple embeddings
   */
  async createEmbeddings(embeddings: any[]): Promise<{ success: boolean; count: number; ids: string[]; error?: string }> {
    try {
      const client = await this.getClient();

      // Use raw SQL for vector operations since Prisma doesn't support vector type
      const insertPromises = embeddings.map(embedding => {
        const embeddingString = `[${embedding.embedding.join(',')}]`;
        return client.$executeRaw`
          INSERT INTO "Embedding" (id, "docId", "chunkIndex", content, embedding, "createdAt", "updatedAt")
          VALUES (${embedding.id}, ${embedding.docId || null}, ${embedding.chunkIndex}, ${embedding.content}, ${embeddingString}::vector, NOW(), NOW())
          ON CONFLICT (id)
          DO UPDATE SET
            "docId" = EXCLUDED."docId",
            "chunkIndex" = EXCLUDED."chunkIndex",
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            "updatedAt" = NOW()
        `;
      });

      // Execute all inserts in parallel
      await Promise.all(insertPromises);

      return {
        success: true,
        count: embeddings.length,
        ids: embeddings.map(emb => emb.id)
      };
    } catch (error: any) {
      console.error("Embeddings creation failed:", error);
      return {
        success: false,
        count: 0,
        ids: [],
        error: error.message || "Failed to create embeddings"
      };
    }
  }

  /**
   * Retrieve multiple embeddings by their IDs
   */
  async getEmbeddings(ids: string[]): Promise<{ success: boolean; embeddings: any[]; count: number; error?: string }> {
    try {
      const client = await this.getClient();

      // Use raw SQL since we can't use Prisma with vector type
      // Cast embedding to text to avoid deserialization issues
      const embeddings = await client.$queryRaw`
        SELECT id, "docId", "chunkIndex", content, embedding::text as embedding, "createdAt"
        FROM "Embedding"
        WHERE id = ANY(${ids})
      `;

      return {
        success: true,
        embeddings: embeddings as any[],
        count: (embeddings as any[]).length
      };
    } catch (error: any) {
      console.error("Embeddings retrieval failed:", error);
      return {
        success: false,
        embeddings: [],
        count: 0,
        error: error.message || "Failed to retrieve embeddings"
      };
    }
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
        SELECT id, "docId", "chunkIndex", content,
               (embedding <=> ${embeddingString}::vector) as distance
        FROM "Embedding"
        WHERE (embedding <=> ${embeddingString}::vector) < ${cosineThreshold}
        ORDER BY embedding <=> ${embeddingString}::vector
        LIMIT ${limit}
      `;

      return {
        success: true,
        embeddings: embeddings as any[],
        count: (embeddings as any[]).length
      };
    } catch (error: any) {
      console.error("Vector similarity search failed:", error);
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
        SELECT id, "batchId", "docId", "chunkIndex", content,
               CASE
                 WHEN embedding IS NOT NULL THEN 'INGESTED'
                 WHEN status = 'FAILED' THEN 'FAILED'
                 ELSE 'ENQUEUED'
               END as status,
               "createdAt", "updatedAt"
        FROM "Embedding"
        WHERE "batchId" = ${batchId}
        ORDER BY "chunkIndex"
      `;

      return {
        success: true,
        embeddings: embeddings as any[],
        count: (embeddings as any[]).length
      };
    } catch (error: any) {
      console.error("Batch embeddings retrieval failed:", error);
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
          COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END) as ingested_chunks,
          COUNT(CASE WHEN status = 'FAILED' THEN 1 END) as failed_chunks,
          COUNT(CASE WHEN embedding IS NULL AND status != 'FAILED' THEN 1 END) as enqueued_chunks,
          MIN("createdAt") as created_at,
          MAX(CASE WHEN embedding IS NOT NULL OR status = 'FAILED' THEN "updatedAt" END) as completed_at
        FROM "Embedding"
        WHERE "batchId" = ${batchId}
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
      console.error("Batch status retrieval failed:", error);
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
   * Close the Prisma client
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
      this.client = undefined;
      console.log('Prisma client disconnected');
    }
  }
}

// Export a singleton instance
export const prismaService = new PrismaService();
