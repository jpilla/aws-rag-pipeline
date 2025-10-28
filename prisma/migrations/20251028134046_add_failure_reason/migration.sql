-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('ENQUEUE_FAILURE', 'COMPUTE_EMBEDDINGS_FAILURE', 'DATA_LAYER_FAILURE');

-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "failureReason" "FailureReason";

