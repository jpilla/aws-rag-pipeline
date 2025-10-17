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
      // Prepare data for Prisma upsert operations
      const upsertPromises = embeddings.map(embedding =>
        client.embedding.upsert({
          where: { id: embedding.id },
          update: {
            docId: embedding.docId || null,
            chunkIndex: embedding.chunkIndex,
            content: embedding.content,
            embedding: embedding.embedding,
          },
          create: {
            id: embedding.id,
            docId: embedding.docId || null,
            chunkIndex: embedding.chunkIndex,
            content: embedding.content,
            embedding: embedding.embedding,
          },
          select: { id: true }
        })
      );

      // Execute all upserts in parallel
      const results = await Promise.all(upsertPromises);

      return {
        success: true,
        count: results.length,
        ids: results.map(result => result.id)
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

      const embeddings = await client.embedding.findMany({
        where: {
          id: {
            in: ids
          }
        },
        select: {
          id: true,
          docId: true,
          chunkIndex: true,
          content: true,
          embedding: true,
          createdAt: true
        }
      });

      return {
        success: true,
        embeddings,
        count: embeddings.length
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
