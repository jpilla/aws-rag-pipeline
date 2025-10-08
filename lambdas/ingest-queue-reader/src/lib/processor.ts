import { logger } from "./logger.js";

export type Payload = {
  type: string;
  data: unknown;
};

export async function processOne(messageId: string, payload: Payload): Promise<void> {
  // TODO: switch on payload.type, route to specific handlers
  logger.info({ messageId, payload }, "Processing SQS message");
  // Simulate work (DB write, call internal service, etc.)
  // Throw to fail this one record only (with reportBatchItemFailures enabled).
}