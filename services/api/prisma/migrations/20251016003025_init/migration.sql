-- CreateTable
CREATE TABLE "Embedding" (
    "id" TEXT NOT NULL,
    "docId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Embedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_embeddings_doc_chunk" ON "Embedding"("docId", "chunkIndex");

