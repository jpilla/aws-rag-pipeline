-- Convert existing embedding column to vector type
-- Convert the embedding column from float8[] to vector(1536)
-- This will work with existing data
ALTER TABLE "Embedding" ALTER COLUMN embedding TYPE vector(1536) USING embedding::vector(1536);
