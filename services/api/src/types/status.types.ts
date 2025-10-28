/**
 * Status API types for batch and chunk status tracking
 */

export type ChunkStatus = 'ENQUEUED' | 'INGESTED' | 'FAILED';

export type FailureReason =
  | 'COMPUTE_EMBEDDINGS_FAILURE'  // Failed to compute embeddings (OpenAI API issues)
  | 'DATA_LAYER_FAILURE';  // Failed to store in database

export interface ChunkStatusInfo {
  chunkId: string;
  chunkIndex: number;
  clientId: string;
  status: ChunkStatus;
  failureReason?: FailureReason;
  createdAt: string;
  updatedAt: string;
}

export interface BatchStatusResponse {
  batchId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NOT_FOUND';
  totalChunks: number;
  enqueuedChunks: number;
  ingestedChunks: number;
  failedChunks: number;
  createdAt?: string;
  completedAt?: string;
  chunks: ChunkStatusInfo[];
}

export interface BatchStatusSummary {
  batchId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NOT_FOUND';
  totalChunks: number;
  enqueuedChunks: number;
  ingestedChunks: number;
  failedChunks: number;
  createdAt?: string;
  completedAt?: string;
}
