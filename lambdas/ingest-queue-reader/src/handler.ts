import type { SQSBatchItemFailure, SQSBatchResponse, SQSHandler } from "aws-lambda";
import { logger } from "./lib/logger.js";
import { processOne, type Payload } from "./lib/processor.js";

const parseJson = (s: string) => {
  try {
    return JSON.parse(s) as Payload;
  } catch (err) {
    return null;
  }
};

// When true, we return only the failed messageIds; Lambda deletes the rest.
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const failures: SQSBatchItemFailure[] = [];

  logger.info({ records: event.Records.length, awsRequestId: (event as any).requestContext?.requestId }, "SQS batch received");

  // Handle messages concurrently but cap concurrency to avoid memory spikes.
  const concurrency = Number(process.env.CONCURRENCY ?? "10");
  const chunks = chunk(event.Records, concurrency);

  for (const group of chunks) {
    await Promise.all(
      group.map(async (record) => {
        const messageId = record.messageId;
        const body = record.body;
        const payload = parseJson(body);

        if (!payload) {
          logger.warn({ messageId }, "Malformed JSON in SQS body");
          failures.push({ itemIdentifier: messageId }); // let it go to DLQ after maxReceiveCount
          return;
        }

        try {
          //await processOne(messageId, payload);
          logger.info({ messageId, payload }, "Message processed");
        } catch (err: any) {
          logger.error({ err, messageId }, "Message processing failed");
          failures.push({ itemIdentifier: messageId });
        }
      })
    );
  }

  if (failures.length) {
    logger.warn({ failed: failures.length }, "Batch completed with failures");
  } else {
    logger.info("Batch completed successfully");
  }

  return { batchItemFailures: failures };
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}