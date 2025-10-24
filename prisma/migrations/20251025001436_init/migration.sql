-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL,
    "docId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Embedding_contentHash_key" ON "Embedding"("contentHash");

-- Create HNSW index for vector similarity search
CREATE INDEX "idx_embeddings_vector_hnsw" ON "Embedding" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
