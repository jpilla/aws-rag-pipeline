/**
 * Types for raw SQL query results
 * These represent the exact structure returned from PostgreSQL queries
 */

export interface SimilarEmbeddingRow {
  id: string;
  docId: string;
  chunkIndex: number;
  content: string;
  distance: number;
}

export interface ChunkWithStatusRow {
  id: string;
  batchId: string;
  clientId: string | null;
  chunkIndex: number;
  content: string;
  status: 'ENQUEUED' | 'INGESTED' | 'FAILED';
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchStatusRow {
  total_chunks: string;
  ingested_chunks: string;
  failed_chunks: string;
  enqueued_chunks: string;
  created_at: Date | null;
  completed_at: Date | null;
}

export interface BatchIdRow {
  batchId: string;
}
