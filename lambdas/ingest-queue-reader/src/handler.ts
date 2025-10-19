import type { SQSBatchItemFailure, SQSBatchResponse, SQSHandler } from "aws-lambda";
import { logger } from "./lib/logger.js";
import { processBatch, type Payload } from "./lib/processor.js";

const parseJson = (s: string) => {
  try {
    return JSON.parse(s) as Payload;
  } catch (err) {
    return null;
  }
};

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
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
