/**
 * Ingest API request and response types
 */

export interface IngestRecord {
  clientId: string;
  content: any;
  metadata?: Record<string, any>;
}

export interface IngestRecordWithId {
  chunkId: string;
  clientId: string;
  content: any;
  metadata?: Record<string, any>;
}

export interface IngestRequest {
  records: IngestRecord[];
}

export interface QueueMessage {
  chunkId: string;
  clientId: string;
  content: any;
  metadata: Record<string, any>;
  batchId: string;
  enqueuedAt: string;
  contentHash: string;
  originalIndex: number;
}

export interface QueueEntry {
  Id: string;
  MessageBody: string;
  _meta: {
    chunkId: string;
    clientId: string;
    idx: number;
  };
}

export interface IngestResult {
  clientId: string;
  originalIndex: number;
  chunkId: string;
  status: "ENQUEUED" | "INGESTED" | "FAILED";
}

export interface IngestError {
  clientId: string;
  originalIndex: number;
  chunkId?: string;
  status: "REJECTED";
  code: string;
  message: string;
}

export interface IngestSummary {
  received: number;
  rejected: number;
  // Note: enqueued/processed counts available via GET /v1/ingest/:batchId
}

export interface IngestResponse {
  batchId: string;
  summary: IngestSummary;
  errors: IngestError[];
  // Note: results array removed - detailed chunk status available via GET /v1/ingest/:batchId
  // This aligns with 202 Accepted pattern: return minimal info, client polls Location header
}
