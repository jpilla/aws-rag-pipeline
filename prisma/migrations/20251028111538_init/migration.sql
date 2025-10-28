-- Enable vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('ENQUEUED', 'INGESTED', 'FAILED');

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "idempotencyKey" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateTable
CREATE TABLE "Embedding" (
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("contentHash")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "clientId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'ENQUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chunk_batchId_chunkIndex_idx" ON "Chunk"("batchId", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_contentHash_batchId_key" ON "Chunk"("contentHash", "batchId");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_contentHash_fkey" FOREIGN KEY ("contentHash") REFERENCES "Embedding"("contentHash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create HNSW index for vector similarity search
CREATE INDEX "Embedding_embedding_hnsw_idx" ON "Embedding" USING hnsw ("embedding" vector_cosine_ops);
