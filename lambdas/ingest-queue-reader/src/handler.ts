import type { SQSBatchItemFailure, SQSBatchResponse, SQSHandler } from "aws-lambda";
import { logger } from "./lib/logger.js";
import { processBatch, type Payload, closeClients } from "./lib/processor.js";

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
    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Error during graceful shutdown");
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

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  // Check if we're shutting down
  if (isShuttingDown) {
    logger.warn("Handler called during shutdown, rejecting all messages");
    return {
      batchItemFailures: event.Records.map(record => ({ itemIdentifier: record.messageId }))
    };
  }

  const failures: SQSBatchItemFailure[] = [];

  logger.info({ records: event.Records.length, awsRequestId: (event as any).requestContext?.requestId }, "SQS batch received");

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
        failed: failureCount
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
