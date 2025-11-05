import axios from 'axios';
import fs from 'fs';
import readline from 'readline';
import path from 'path';

// TypeScript interfaces for API responses
interface QueryResponse {
  query: string;
  answer: string;
  context: ContextChunk[];
  matches: number;
}

interface ContextChunk {
  content: string;
  [key: string]: any;
}

interface IngestRecord {
  clientId: string;
  content: string;
}

interface IngestResponse {
  batchId: string;
  summary: any;
}

interface BatchStatusResponse {
  batchId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NOT_FOUND';
  totalChunks: number;
  ingestedChunks: number;
  failedChunks: number;
}

// Setting the base URL for axios makes it easier to make requests
const api = axios.create({
  baseURL: process.env.BASE_URL,
  timeout: 10000, // 10 second timeout
  // Let axios handle connection pooling internally
});

describe('RAG Pipeline Integration', () => {
  it('should ingest Amazon reviews data and return relevant results', async () => {
    // 1. First, ingest the Amazon reviews data via API
    // In Docker, the file is copied to the working directory (/app)
    // Locally, it's at the project root, so try both locations
    const jsonlPath = path.join(process.cwd(), 'Amazon_Reviews_Short.jsonl');
    const jsonlPathAlt = path.join(__dirname, '..', 'Amazon_Reviews_Short.jsonl');
    const filePath = fs.existsSync(jsonlPath) ? jsonlPath : jsonlPathAlt;
    const batchIds = await ingestJsonlData(filePath, 10);

    // 2. Wait for all batches to be processed
    await waitForBatchesToComplete(batchIds);

    // 3. Query the endpoint with a question about mini farm animals
    const queryResponse = await api.post<QueryResponse>('/v1/query', {
      query: 'What do you know about mini farm animals?',
      limit: 5,
      threshold: 0.7
    });

    expect(queryResponse.status).toBe(200);
    expect(queryResponse.data).toHaveProperty('query');
    expect(queryResponse.data).toHaveProperty('answer');
    expect(queryResponse.data).toHaveProperty('context');
    expect(queryResponse.data).toHaveProperty('matches');

    // 4. Assert that we found embeddings and got a response (basic integration test)
    expect(queryResponse.data.matches).toBeGreaterThan(0);
    expect(queryResponse.data.context.length).toBeGreaterThan(0);

    // 5. Check that we didn't get the "no information" response
    expect(queryResponse.data.answer).not.toBe("I couldn't find any relevant information to answer your question.");

    // 6. Verify the context contains the expected keywords (proves ingestion worked)
    const contextText = queryResponse.data.context.map((chunk: ContextChunk) => chunk.content).join(' ').toLowerCase();
    expect(contextText).toContain('mini farm animals');
  }, 60000); // 60 second timeout for this test
});

// Helper function to ingest JSONL data via API
async function ingestJsonlData(filePath: string, batchSize: number = 10): Promise<string[]> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let batch: IngestRecord[] = [];
  let batchIndex = 0;
  const batchIds: string[] = [];

  for await (const line of rl) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    try {
      const record: any = JSON.parse(trimmedLine);

      // Transform the record to match the API format
      const clientId = record.id || `${record.asin || 'noasin'}_${record?.meta?.review_time || 'nodate'}`;
      const content = record.embedding_text || record.text || record?.meta?.review_text || '';

      if (!content) continue; // skip empty content

      batch.push({ clientId, content });

      // Send batch when it reaches the batch size
      if (batch.length >= batchSize) {
        const batchId = await sendBatch(batch, batchIndex);
        if (batchId) {
          batchIds.push(batchId);
        }
        batch = [];
        batchIndex++;
      }
    } catch (error) {
      continue;
    }
  }

  // Send remaining records
  if (batch.length > 0) {
    const batchId = await sendBatch(batch, batchIndex);
    if (batchId) {
      batchIds.push(batchId);
    }
  }

  return batchIds;
}

async function sendBatch(records: IngestRecord[], batchIndex: number): Promise<string | null> {
  try {
    const response = await api.post<IngestResponse>('/v1/ingest', { records });
    return response.data.batchId;
  } catch (error: any) {
    console.error(`Failed to send batch ${batchIndex}:`, error.message);
    return null;
  }
}

// Wait for all batches to complete processing
async function waitForBatchesToComplete(batchIds: string[], maxWaitTime: number = 60000): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000; // Poll every 2 seconds

  while (Date.now() - startTime < maxWaitTime) {
    let allComplete = true;

    for (const batchId of batchIds) {
      try {
        const statusResponse = await api.get<BatchStatusResponse>(`/v1/ingest/${batchId}`);
        const status = statusResponse.data.status;

        if (status === 'FAILED') {
          throw new Error(`Batch ${batchId} failed during processing`);
        }

        if (status !== 'COMPLETED') {
          allComplete = false;
          break;
        }
      } catch (error: any) {
        if (error.response?.status === 404) {
          // Batch not found yet, keep waiting
          allComplete = false;
          break;
        }
        throw error;
      }
    }

    if (allComplete) {
      return;
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Batches did not complete within ${maxWaitTime}ms`);
}
