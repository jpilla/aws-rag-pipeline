export interface QueryRequest {
  query: string;
  limit?: number;
  threshold?: number;
}

export interface QueryResponse {
  query: string;
  answer: string;
  context: ContextChunk[];
  matches: number;
}

export interface ContextChunk {
  id: string;
  docId: string | null;
  chunkIndex: number;
  content: string;
  distance: number;
}

export interface SimilaritySearchResult {
  success: boolean;
  embeddings: any[];
  count: number;
  error?: string;
}
