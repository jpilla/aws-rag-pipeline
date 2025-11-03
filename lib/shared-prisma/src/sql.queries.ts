import { PrismaClient } from '@prisma/client';
import {
  SimilarEmbeddingRow,
  ChunkWithStatusRow,
  BatchStatusRow,
  BatchIdRow,
  ExistingEmbeddingRow,
} from './types';

/**
 * SQL Query Builder for PrismaService
 * Encapsulates all raw SQL operations for better testability
 * Contains all SQL queries used by both API and Lambda services
 */
export class SqlQueries {
  /**
   * Test database connectivity
   */
  async executeHealthCheck(client: PrismaClient): Promise<void> {
    await client.$queryRaw`SELECT 1`;
  }

  /**
   * Find similar embeddings using vector similarity search with pgvector
   */
  async findSimilarEmbeddings(
    client: PrismaClient,
    embeddingString: string,
    cosineThreshold: number,
    limit: number
  ): Promise<SimilarEmbeddingRow[]> {
    const result = await client.$queryRaw`
      SELECT c.id, c."batchId" as "docId", c."chunkIndex", c.content,
             (e.embedding <=> ${embeddingString}::vector) as distance
      FROM "Embedding" e
      JOIN "Chunk" c ON e."contentHash" = c."contentHash"
      WHERE (e.embedding <=> ${embeddingString}::vector) < ${cosineThreshold}
      ORDER BY e.embedding <=> ${embeddingString}::vector
      LIMIT ${limit}
    `;
    return result as SimilarEmbeddingRow[];
  }

  /**
   * Get chunks by batchId with status information
   */
  async getChunksByBatchId(client: PrismaClient, batchId: string): Promise<ChunkWithStatusRow[]> {
    const result = await client.$queryRaw`
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
    return result as ChunkWithStatusRow[];
  }

  /**
   * Get batch status summary
   */
  async getBatchStatus(client: PrismaClient, batchId: string): Promise<BatchStatusRow[]> {
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
    return result as BatchStatusRow[];
  }

  /**
   * Store idempotency key mapping
   */
  async storeIdempotencyKey(
    client: PrismaClient,
    idempotencyKey: string,
    batchId: string
  ): Promise<void> {
    await client.$executeRaw`
      INSERT INTO "IdempotencyKey" ("idempotencyKey", "batchId", "createdAt")
      VALUES (${idempotencyKey}, ${batchId}, NOW())
      ON CONFLICT ("idempotencyKey") DO NOTHING
    `;
  }

  /**
   * Get batch ID by idempotency key
   */
  async getBatchByKey(client: PrismaClient, idempotencyKey: string): Promise<BatchIdRow[]> {
    const result = await client.$queryRaw`
      SELECT "batchId" FROM "IdempotencyKey"
      WHERE "idempotencyKey" = ${idempotencyKey}
      LIMIT 1
    `;
    return result as BatchIdRow[];
  }

  // ============= Lambda-specific queries =============

  /**
   * Insert placeholder embeddings (used by Lambda)
   */
  async insertPlaceholderEmbeddings(
    client: PrismaClient,
    contentHashes: string[]
  ): Promise<void> {
    await client.$executeRaw`
      INSERT INTO "Embedding" ("contentHash", embedding, "createdAt")
      SELECT
        unnest(${contentHashes}::text[]) as "contentHash",
        NULL as embedding,
        NOW() as "createdAt"
      ON CONFLICT ("contentHash") DO NOTHING
    `;
  }

  /**
   * Insert chunks with ENQUEUED status (used by Lambda)
   */
  async insertChunks(
    client: PrismaClient,
    chunkIds: string[],
    contentHashes: string[],
    batchIds: string[],
    clientIds: string[],
    chunkIndexes: number[],
    contents: string[]
  ): Promise<void> {
    await client.$executeRaw`
      INSERT INTO "Chunk" (id, "contentHash", "batchId", "clientId", "chunkIndex", content, status, "createdAt", "updatedAt")
      SELECT
        unnest(${chunkIds}::text[]) as id,
        unnest(${contentHashes}::text[]) as "contentHash",
        unnest(${batchIds}::text[]) as "batchId",
        unnest(${clientIds}::text[]) as "clientId",
        unnest(${chunkIndexes}::int[]) as "chunkIndex",
        unnest(${contents}::text[]) as content,
        'ENQUEUED' as status,
        NOW() as "createdAt",
        NOW() as "updatedAt"
      ON CONFLICT ("contentHash", "batchId") DO NOTHING
    `;
  }

  /**
   * Check which embeddings already exist (used by Lambda)
   */
  async getExistingEmbeddings(
    client: PrismaClient,
    contentHashes: string[]
  ): Promise<ExistingEmbeddingRow[]> {
    const result = await client.$queryRaw<ExistingEmbeddingRow[]>`
      SELECT "contentHash", embedding::text as embedding FROM "Embedding"
      WHERE "contentHash" = ANY(${contentHashes}) AND embedding IS NOT NULL
    `;
    return result;
  }

  /**
   * Update embeddings with computed values (used by Lambda)
   */
  async updateEmbeddings(
    client: PrismaClient,
    contentHashes: string[],
    embeddingStrings: string[]
  ): Promise<void> {
    await client.$executeRaw`
      UPDATE "Embedding"
      SET embedding = subq.embedding
      FROM (
        SELECT
          unnest(${contentHashes}::text[]) as "contentHash",
          unnest(${embeddingStrings}::vector[]) as embedding
      ) AS subq
      WHERE "Embedding"."contentHash" = subq."contentHash"
    `;
  }

  /**
   * Update chunk status to INGESTED (used by Lambda)
   */
  async updateChunksToIngested(
    client: PrismaClient,
    contentHashes: string[]
  ): Promise<void> {
    await client.$executeRaw`
      UPDATE "Chunk"
      SET status = 'INGESTED', "updatedAt" = NOW()
      WHERE "contentHash" = ANY(${contentHashes})
    `;
  }

  /**
   * Update chunk status to FAILED (used by Lambda)
   */
  async updateChunksToFailed(
    client: PrismaClient,
    chunkIds: string[],
    failureReason: string
  ): Promise<void> {
    await client.$executeRaw`
      UPDATE "Chunk"
      SET status = 'FAILED', "failureReason" = ${failureReason}, "updatedAt" = NOW()
      WHERE id = ANY(${chunkIds})
    `;
  }
}
