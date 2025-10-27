-- AlterTable
ALTER TABLE "Embedding" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "Embedding_batchId_chunkIndex_idx" ON "Embedding"("batchId", "chunkIndex");

