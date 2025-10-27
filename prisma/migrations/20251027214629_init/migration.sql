CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "ProcessingStatus" AS ENUM ('ENQUEUED', 'INGESTED', 'FAILED');

CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL,
    "docId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "status" "ProcessingStatus" NOT NULL DEFAULT 'ENQUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_embeddings_vector_hnsw" ON "Embedding" USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE embedding IS NOT NULL;
