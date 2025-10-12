import { Router, Request, Response } from "express";
import { IngestService } from "../services/ingest.service";
import { IngestRequest, IngestResponse, IngestSummary } from "../types/ingest.types";

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
  // Validate environment configuration
  if (!QUEUE_URL) {
    return res.status(500).json({ error: "INGEST_QUEUE_URL not set" });
  }

  const service = getIngestService();
  const { records } = req.body as IngestRequest;

  // Validate request payload
  if (!service.validateRecords(records)) {
    return res.status(400).json({ error: "records[] required" });
  }

  try {
    // Process the records
    const { batchId, results, errors } = await service.ingest(records);

    // Build summary
    const summary: IngestSummary = {
      received: records.length,
      enqueued: results.length,
      rejected: errors.length,
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

    res.status(status).json(response);
  } catch (error: any) {
    res.status(500).json({
      error: "Internal server error",
      message: error.message ?? String(error),
    });
  }
});

export default router;

