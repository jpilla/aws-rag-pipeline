import type { SQSBatchItemFailure, SQSBatchResponse, SQSHandler } from "aws-lambda";
import { logger } from "./lib/logger.js";
import { processBatch, type Payload, closeClients, initializeClients } from "./lib/processor.js";

// In production: initialize at module load for faster cold starts
// In debug mode: initialize lazily to allow debugger to attach
const DEBUG_MODE = process.env.LAMBDA_DEBUG === 'true';

let clientsInitialized = false;
let clientsReady: Promise<void>;

// Module-load initialization for production
if (!DEBUG_MODE) {
  clientsReady = initializeClients()
    .then(() => {
      clientsInitialized = true;
      logger.info("Lambda clients initialized at module load");
    })
    .catch((error) => {
      logger.error({ error }, "Failed to initialize clients at module load");
      clientsReady = Promise.reject(error);
    });
} else {
  // Debug mode: lazy initialization
  clientsReady = Promise.resolve();
}

// Lazy initialization for debug mode
function ensureClientsReady(): Promise<void> {
  if (clientsInitialized) {
    return Promise.resolve();
  }

  if (!DEBUG_MODE && clientsReady) {
    return clientsReady;
  }

  // Debug mode or first-time init: initialize now
  clientsReady = initializeClients()
    .then(() => {
      clientsInitialized = true;
      logger.info("Lambda clients initialized");
    })
    .catch((error) => {
      logger.error({ error }, "Failed to initialize Lambda clients");
      throw error;
    });

  return clientsReady;
}

export const handler = async (event: any): Promise<SQSBatchResponse> => {
  try {
    await ensureClientsReady();
    return await processRequest(event);
  } catch (error) {
    logger.error({ error }, "Handler failed due to client initialization error");
    return {
      batchItemFailures: event.Records.map((record: any) => ({ itemIdentifier: record.messageId }))
    };
  }
};

// Set up graceful shutdown handlers
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress, ignoring signal");
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, "Received shutdown signal, closing connections...");

  try {
    await closeClients();
    logger.info("Lambda graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Error during Lambda graceful shutdown");
    process.exit(1);
  }
};

// Handle different shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', async (error) => {
  logger.error({ error }, "Uncaught exception, shutting down gracefully");
  await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled rejection, shutting down gracefully");
  await gracefulShutdown('unhandledRejection');
});

const parseJson = (s: string) => {
  try {
    return JSON.parse(s) as Payload;
  } catch (err) {
    return null;
  }
};

async function processRequest(event: any): Promise<SQSBatchResponse> {
  // Check if we're shutting down
  if (isShuttingDown) {
    logger.warn("Handler called during shutdown, rejecting all messages");
    return {
      batchItemFailures: event.Records.map((record: any) => ({ itemIdentifier: record.messageId }))
    };
  }

  const failures: SQSBatchItemFailure[] = [];

  // Extract request-ids from message bodies for batch-level logging
  const requestIds = event.Records.map((record: any) => {
    try {
      const payload = JSON.parse(record.body);
      return payload.metadata?.requestId;
    } catch {
      return null;
    }
  }).filter(Boolean);
  const uniqueRequestIds = [...new Set(requestIds)];

  logger.info({
    records: event.Records.length,
    awsRequestId: (event as any).requestContext?.requestId,
    requestIds: uniqueRequestIds.length > 0 ? uniqueRequestIds : undefined
  }, "SQS batch received");

  // Parse all records and separate valid from invalid ones
  const validRecords: Array<{ messageId: string; payload: Payload }> = [];

  for (const record of event.Records) {
    const messageId = record.messageId;
    const body = record.body;
    const payload = parseJson(body);

    if (!payload) {
      logger.warn({ messageId }, "Malformed JSON in SQS body");
      failures.push({ itemIdentifier: messageId });
    } else {
      validRecords.push({ messageId, payload });
    }
  }

  // Process all valid records in a single batch
  if (validRecords.length > 0) {
    try {
      const results = await processBatch(validRecords);

      // Add any failed records to the failures list
      results.forEach(result => {
        if (!result.success) {
          failures.push({ itemIdentifier: result.messageId });
        }
      });

      const successCount = results.filter(r => r.success).length;
      const failureCount = results.filter(r => !r.success).length;

      logger.info({
        total: validRecords.length,
        success: successCount,
        failed: failureCount,
        requestIds: uniqueRequestIds.length > 0 ? uniqueRequestIds : undefined
      }, "Batch processing completed");

    } catch (err: any) {
      logger.error({ err }, "Batch processing failed completely");
      // If the entire batch fails, mark all valid records as failed
      validRecords.forEach(record => {
        failures.push({ itemIdentifier: record.messageId });
      });
    }
  }

  if (failures.length) {
    logger.warn({ failed: failures.length }, "Batch completed with failures");
  } else {
    logger.info("Batch completed successfully");
  }

  return { batchItemFailures: failures };
};
