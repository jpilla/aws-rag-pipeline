/**
 * Ingest API request and response types
 */

export interface IngestRecord {
  chunkId?: string;
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
  messageId: string;
  status: "enqueued";
}

export interface IngestError {
  clientId: string;
  originalIndex: number;
  chunkId?: string;
  status: "rejected";
  code: string;
  message: string;
}

export interface IngestSummary {
  received: number;
  enqueued: number;
  rejected: number;
}

export interface IngestResponse {
  batchId: string;
  summary: IngestSummary;
  results: IngestResult[];
  errors: IngestError[];
}

