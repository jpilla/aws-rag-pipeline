import { Router, Request, Response } from "express";
import { IngestService } from "../services/ingest.service";
import { prismaService } from "../services/prisma.service";
import { IngestRequest, IngestResponse, IngestSummary } from "../types/ingest.types";
import { BatchStatusResponse, ChunkStatusInfo, ChunkStatus, FailureReason } from "../types/status.types";

const router = Router();

// Initialize the ingest service
const QUEUE_URL = process.env.INGEST_QUEUE_URL!;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

let ingestService: IngestService | null = null;

/**
 * Lazy initialization of ingest service
 */
function getIngestService(): IngestService {
  if (!ingestService && QUEUE_URL) {
    ingestService = new IngestService(QUEUE_URL, AWS_REGION);
  }
  return ingestService!;
}

/**
 * POST /v1/ingest
 * Ingests records into the SQS queue for processing
 */
router.post("/v1/ingest", async (req: Request, res: Response) => {
  const requestStartTime = Date.now();

  // Validate environment configuration
  if (!QUEUE_URL) {
    return res.status(500).json({ error: "INGEST_QUEUE_URL not set" });
  }

  const service = getIngestService();
  const { records } = req.body as IngestRequest;
  // Support both standard Idempotency-Key and lowercase idempotency-key headers
  const idempotencyKey = (req.headers['Idempotency-Key'] || req.headers['idempotency-key']) as string;

  // Validate request payload
  if (!service.validateRecords(records)) {
    return res.status(400).json({ error: "records[] required" });
  }

  try {
    req.logger.info({
      recordCount: records.length,
      idempotencyKey
    }, "Processing ingest request");

    // Process the records
    const { batchId, results, errors } = await service.ingest(records, idempotencyKey, req.requestId);

    // Build summary - distinguish between actually enqueued vs already processed
    const actuallyEnqueued = results.filter(r => r.processingStatus === 'ENQUEUED').length;
    const alreadyProcessed = results.filter(r => r.processingStatus === 'INGESTED').length;

    const summary: IngestSummary = {
      received: records.length,
      enqueued: actuallyEnqueued,
      rejected: errors.length,
      ...(alreadyProcessed > 0 && { alreadyProcessed }),
    };

    // Determine response status
    const status = results.length > 0 ? 202 : 503;

    // Send response
    const response: IngestResponse = {
      batchId,
      summary,
      results,
      errors,
    };

    const totalDuration = Date.now() - requestStartTime;
    req.logger.info({
      batchId,
      duration: totalDuration,
      summary
    }, "Ingest API completed");

    // Add Location header for the created resource
    res.set('Location', `/v1/ingest/${batchId}`);
    res.status(status).json(response);
  } catch (error: any) {
    const totalDuration = Date.now() - requestStartTime;
    req.logger.error({
      duration: totalDuration,
      error: error.message ?? String(error)
    }, "Ingest API failed");

    res.status(500).json({
      error: "Internal server error",
      message: error.message ?? String(error),
    });
  }
});

/**
 * GET /v1/ingest/:batchId
 * Checks the status of a specific ingest batch
 */
router.get("/v1/ingest/:batchId", async (req: Request, res: Response) => {
  try {
    const { batchId } = req.params;
    req.logger.info({ batchId }, "Checking batch status");

    if (!batchId) {
      return res.status(400).json({ error: "batchId parameter is required" });
    }

    // Get batch status summary
    const batchStatus = await prismaService.getBatchStatus(batchId);

    if (!batchStatus.success) {
      return res.status(500).json({
        error: "Failed to retrieve batch status",
        message: batchStatus.error
      });
    }

    // If no chunks found, return NOT_FOUND
    if (batchStatus.totalChunks === 0) {
      const response: BatchStatusResponse = {
        batchId,
        status: 'NOT_FOUND',
        totalChunks: 0,
        enqueuedChunks: 0,
        ingestedChunks: 0,
        failedChunks: 0,
        chunks: []
      };
      return res.status(404).json(response);
    }

    // Get detailed chunk information
    const chunkData = await prismaService.getEmbeddingsByBatchId(batchId);

    if (!chunkData.success) {
      return res.status(500).json({
        error: "Failed to retrieve chunk details",
        message: chunkData.error
      });
    }

    // Transform chunk data to our response format
    const chunks: ChunkStatusInfo[] = chunkData.embeddings.map((chunk: any) => ({
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      clientId: chunk.clientId,
      status: chunk.status as ChunkStatus,
      failureReason: chunk.failureReason as FailureReason | undefined,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt
    }));

    // Determine overall batch status
    let overallStatus: 'PROCESSING' | 'COMPLETED' | 'FAILED';
    if (batchStatus.failedChunks === batchStatus.totalChunks) {
      overallStatus = 'FAILED';
    } else if (batchStatus.ingestedChunks + batchStatus.failedChunks === batchStatus.totalChunks) {
      overallStatus = 'COMPLETED';
    } else {
      overallStatus = 'PROCESSING';
    }

    const response: BatchStatusResponse = {
      batchId,
      status: overallStatus,
      totalChunks: batchStatus.totalChunks,
      enqueuedChunks: batchStatus.enqueuedChunks,
      ingestedChunks: batchStatus.ingestedChunks,
      failedChunks: batchStatus.failedChunks,
      createdAt: batchStatus.createdAt,
      completedAt: batchStatus.completedAt,
      chunks
    };

    res.json(response);

  } catch (error: any) {
    req.logger.error({
      batchId: req.params.batchId,
      error: error.message ?? String(error)
    }, "Status check failed");
    res.status(500).json({
      error: "Internal server error",
      message: error.message ?? String(error),
    });
  }
});

export default router;
