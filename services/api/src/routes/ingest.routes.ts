import { Router, Request, Response } from "express";
import { IngestService, createIngestService } from "../services/ingest.service";
import { PrismaDatabaseAdapter } from "../services/adapters/database.adapter";
import { AwsSqsAdapter } from "../services/adapters/sqs.adapter";
import { prismaService } from "../services/prisma.service";
import { IngestRequest, IngestResponse, IngestSummary } from "../types/ingest.types";
import { BatchStatusResponse, ChunkStatusInfo, ChunkStatus, FailureReason } from "../types/status.types";
import { ChunkWithStatusRow } from "../types/database.types";
import { createValidationMiddleware, sendValidationError } from "../middleware/validation";
import { IngestValidators } from "../middleware/ingestValidation";
import { logger } from "../lib/logger";

const router = Router();

// Initialize the ingest service
const QUEUE_URL = process.env.INGEST_QUEUE_URL!;
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

let ingestService: IngestService | null = null;

/**
 * Initialize ingest service at startup (called from server.ts)
 */
export async function initializeIngestService(): Promise<void> {
  if (!QUEUE_URL) {
    throw new Error("INGEST_QUEUE_URL environment variable not set");
  }

  if (!AWS_REGION) {
    throw new Error(
      "AWS_REGION is required. Please set AWS_REGION or AWS_DEFAULT_REGION environment variable."
    );
  }

  if (!ingestService) {
    const databaseService = new PrismaDatabaseAdapter();
    const sqsService = new AwsSqsAdapter(AWS_REGION);
    ingestService = createIngestService(QUEUE_URL, databaseService, sqsService);
    await ingestService.initialize();
  }
}

/**
 * Get the pre-initialized ingest service
 */
function getIngestService(): IngestService {
  if (!ingestService) {
    throw new Error("IngestService not initialized. Call initializeIngestService() first.");
  }
  return ingestService;
}

/**
 * POST /v1/ingest
 * Ingests records into the SQS queue for processing
 */
router.post("/v1/ingest", createValidationMiddleware(IngestValidators.validateIngestRequest), async (req: Request, res: Response) => {
  const requestStartTime = Date.now();

  // Validate environment configuration
  if (!QUEUE_URL) {
    return res.status(500).json({ error: "INGEST_QUEUE_URL not set" });
  }

  const service = getIngestService();
  const { records } = req.body as IngestRequest;
  // Support both standard Idempotency-Key and lowercase idempotency-key headers
  const idempotencyKey = (req.headers['Idempotency-Key'] || req.headers['idempotency-key']) as string;

  try {
    logger.info({
      recordCount: records.length,
      idempotencyKey
    }, "Processing ingest request");

    // Process the records
    const { batchId, results, errors } = await service.ingest(records, idempotencyKey, req.requestId);

    // Determine response status
    // If ANY SQS errors occurred (even partial), return 5xx so client retries everything
    // 202 Accepted: all records successfully enqueued to SQS
    // 503: any SQS failures occurred (client should retry entire request)
    const hasSqsErrors = errors.length > 0;
    const status = hasSqsErrors ? 503 : 202;

    // Build summary
    const summary: IngestSummary = {
      received: records.length,
      rejected: errors.length,
      enqueued: results.length,
    };

    // Send response
    const response: IngestResponse = {
      batchId,
      summary,
      errors, // Only immediate synchronous rejections (e.g., SQS validation failures)
      // results array removed - check GET endpoint for detailed chunk status
    };

    const totalDuration = Date.now() - requestStartTime;
    logger.info({
      batchId,
      duration: totalDuration,
      summary
    }, "Ingest API completed");

    // Add Location header for the created resource
    res.set('Location', `/v1/ingest/${batchId}`);
    res.status(status).json(response);
  } catch (error: any) {
    const totalDuration = Date.now() - requestStartTime;
    logger.error({
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
    logger.info({ batchId }, "Checking batch status");

    // Validate batch ID
    const validationResult = IngestValidators.validateBatchId(batchId);
    if (!validationResult.isValid) {
      return sendValidationError(res, validationResult.errors);
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
    const chunkData = await prismaService.getChunksByBatchId(batchId);

    if (!chunkData.success) {
      return res.status(500).json({
        error: "Failed to retrieve chunk details",
        message: chunkData.error
      });
    }

    // Transform chunk data to our response format
    // Only include failureReason if it's not null (i.e., there was an actual failure)
    const chunks: ChunkStatusInfo[] = chunkData.chunks.map((chunk: ChunkWithStatusRow) => {
      const chunkInfo: ChunkStatusInfo = {
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        clientId: chunk.clientId || '',
        status: chunk.status as ChunkStatus,
        createdAt: chunk.createdAt.toISOString(),
        updatedAt: chunk.updatedAt.toISOString()
      };

      // Only include failureReason if there was an actual failure
      if (chunk.failureReason) {
        chunkInfo.failureReason = chunk.failureReason as FailureReason;
      }

      return chunkInfo;
    });

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
    logger.error({
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
