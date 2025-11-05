import { PrismaClient } from "@prisma/client";
import { logger } from "../logger.js";

export interface DatabaseService {
  insertPlaceholderEmbeddings(contentHashes: string[]): Promise<void>;
  insertChunksWithEnqueuedStatus(
    chunkIds: string[],
    contentHashes: string[],
    batchIds: string[],
    clientIds: string[],
    chunkIndexes: number[],
    contents: string[]
  ): Promise<void>;
  findExistingEmbeddings(contentHashes: string[]): Promise<Set<string>>;
  updateEmbeddingsWithGeneratedValues(
    contentHashes: string[],
    embeddings: number[][]
  ): Promise<void>;
  updateChunkStatusToIngested(contentHashes: string[]): Promise<void>;
  updateChunkStatusToFailed(
    chunkIds: string[],
    failureReason: string
  ): Promise<void>;
}

export class PrismaDatabaseService implements DatabaseService {
  constructor(private prisma: PrismaClient) {}

  async insertPlaceholderEmbeddings(contentHashes: string[]): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "Embedding" ("contentHash", embedding, "createdAt")
      SELECT
        unnest(${contentHashes}::text[]) as "contentHash",
        NULL as embedding,
        NOW() as "createdAt"
      ON CONFLICT ("contentHash") DO NOTHING
    `;
  }

  async insertChunksWithEnqueuedStatus(
    chunkIds: string[],
    contentHashes: string[],
    batchIds: string[],
    clientIds: string[],
    chunkIndexes: number[],
    contents: string[]
  ): Promise<void> {
    await this.prisma.$executeRaw`
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

  async findExistingEmbeddings(contentHashes: string[]): Promise<Set<string>> {
    const existingEmbeddings = await this.prisma.$queryRaw<
      Array<{ contentHash: string }>
    >`
      SELECT "contentHash" FROM "Embedding"
      WHERE "contentHash" = ANY(${contentHashes}) AND embedding IS NOT NULL
    `;

    return new Set(
      existingEmbeddings.map((record: { contentHash: string }) => record.contentHash)
    );
  }

  async updateEmbeddingsWithGeneratedValues(
    contentHashes: string[],
    embeddings: number[][]
  ): Promise<void> {
    const embeddingStrings = embeddings.map(
      (embedding) => `[${embedding.join(",")}]`
    );

    await this.prisma.$executeRaw`
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

  async updateChunkStatusToIngested(
    contentHashes: string[]
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Chunk"
      SET status = 'INGESTED', "updatedAt" = NOW()
      WHERE "contentHash" = ANY(${contentHashes})
    `;
  }

  async updateChunkStatusToFailed(
    chunkIds: string[],
    failureReason: string
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "Chunk"
      SET status = 'FAILED', "failureReason" = ${failureReason}, "updatedAt" = NOW()
      WHERE id = ANY(${chunkIds})
    `;
  }
}

export function createDatabaseService(
  prisma: PrismaClient
): DatabaseService {
  return new PrismaDatabaseService(prisma);
}
