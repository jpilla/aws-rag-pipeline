-- CreateIndex
CREATE INDEX "idx_embeddings_vector_hnsw" ON "Embedding" USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
