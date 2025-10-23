-- AlterTable
ALTER TABLE "Embedding" ADD COLUMN     "contentHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Embedding_contentHash_key" ON "Embedding"("contentHash");

