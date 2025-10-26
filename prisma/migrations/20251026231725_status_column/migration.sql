-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('ENQUEUED', 'INGESTED', 'FAILED');

-- AlterTable
ALTER TABLE "Embedding" ADD COLUMN     "status" "ProcessingStatus" NOT NULL DEFAULT 'INGESTED';

-- Make embedding column nullable for two-phase processing
ALTER TABLE "Embedding" ALTER COLUMN "embedding" DROP NOT NULL;

-- Drop the existing HNSW index and recreate it to exclude NULL values
DROP INDEX IF EXISTS "idx_embeddings_vector_hnsw";
CREATE INDEX "idx_embeddings_vector_hnsw" ON "Embedding" USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE embedding IS NOT NULL;
