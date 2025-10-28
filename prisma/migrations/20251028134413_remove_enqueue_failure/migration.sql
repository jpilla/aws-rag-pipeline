-- AlterEnum
BEGIN;
CREATE TYPE "FailureReason_new" AS ENUM ('COMPUTE_EMBEDDINGS_FAILURE', 'DATA_LAYER_FAILURE');
ALTER TABLE "Chunk" ALTER COLUMN "failureReason" TYPE "FailureReason_new" USING ("failureReason"::text::"FailureReason_new");
ALTER TYPE "FailureReason" RENAME TO "FailureReason_old";
ALTER TYPE "FailureReason_new" RENAME TO "FailureReason";
DROP TYPE "FailureReason_old";
COMMIT;

