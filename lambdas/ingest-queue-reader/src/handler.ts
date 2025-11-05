import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSHandler,
} from "aws-lambda";
import { logger } from "./lib/logger.js";
import {
  BatchProcessor,
  type Payload,
  createBatchProcessor,
} from "./lib/processor.js";
import {
  ClientInitializationService,
  createClientInitializationService,
} from "./lib/services/client-initialization.service.js";
import {
  DatabaseService,
  createDatabaseService,
} from "./lib/services/database.service.js";
import {
  EmbeddingService,
  createEmbeddingService,
} from "./lib/services/embedding.service.js";

export class SQSHandlerService {
  private batchProcessor: BatchProcessor | null = null;
  private isShuttingDown = false;

  constructor(
    private clientInitializationService: ClientInitializationService,
    private createBatchProcessorFn: (
      databaseService: DatabaseService,
      embeddingService: EmbeddingService
    ) => BatchProcessor = createBatchProcessor
  ) {
    this.setupGracefulShutdownHandlers();
  }

  async handle(event: any): Promise<SQSBatchResponse> {
    if (this.isShuttingDown) {
      logger.warn("Handler called during shutdown, rejecting all messages");
      return this.createFailureResponseForAllRecords(event.Records);
    }

    try {
      await this.ensureClientsInitialized();
      return await this.processRequest(event);
    } catch (error) {
      logger.error({ error }, "Handler failed due to client initialization error");
      return this.createFailureResponseForAllRecords(event.Records);
    }
  }

  private async ensureClientsInitialized(): Promise<void> {
    if (this.batchProcessor) {
      return;
    }

    const prisma =
      await this.clientInitializationService.initializePrismaClient();
    const openai =
      await this.clientInitializationService.initializeOpenAIClient();

    const databaseService = createDatabaseService(prisma);
    const embeddingService = createEmbeddingService(openai);

    this.batchProcessor = this.createBatchProcessorFn(
      databaseService,
      embeddingService
    );
  }

  private async processRequest(event: any): Promise<SQSBatchResponse> {
    const requestIds = this.extractRequestIdsFromRecords(event.Records);
    logger.info(
      {
        records: event.Records.length,
        awsRequestId: (event as any).requestContext?.requestId,
        requestIds: requestIds.length > 0 ? requestIds : undefined,
      },
      "SQS batch received"
    );

    const { validRecords, invalidRecords } = this.parseAndValidateRecords(
      event.Records
    );

    if (validRecords.length === 0) {
      return this.createResponseFromInvalidRecords(invalidRecords);
    }

    try {
      const results = await this.batchProcessor!.processBatch(validRecords);
      return this.createResponseFromResults(results, invalidRecords, requestIds);
    } catch (err: any) {
      logger.error({ err }, "Batch processing failed completely");
      return this.createFailureResponseForAllRecords(event.Records);
    }
  }

  private extractRequestIdsFromRecords(records: any[]): string[] {
    const requestIds = records
      .map((record) => {
        try {
          const payload = JSON.parse(record.body);
          return payload.metadata?.requestId;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return [...new Set(requestIds)];
  }

  private parseAndValidateRecords(records: any[]): {
    validRecords: Array<{ messageId: string; payload: Payload }>;
    invalidRecords: SQSBatchItemFailure[];
  } {
    const validRecords: Array<{ messageId: string; payload: Payload }> = [];
    const invalidRecords: SQSBatchItemFailure[] = [];

    for (const record of records) {
      const messageId = record.messageId;
      const payload = this.parseJson(record.body);

      if (!payload) {
        logger.warn({ messageId }, "Malformed JSON in SQS body");
        invalidRecords.push({ itemIdentifier: messageId });
      } else {
        validRecords.push({ messageId, payload });
      }
    }

    return { validRecords, invalidRecords };
  }

  private parseJson(body: string): Payload | null {
    try {
      return JSON.parse(body) as Payload;
    } catch {
      return null;
    }
  }

  private createResponseFromInvalidRecords(
    invalidRecords: SQSBatchItemFailure[]
  ): SQSBatchResponse {
    return { batchItemFailures: invalidRecords };
  }

  private createResponseFromResults(
    results: Array<{ messageId: string; success: boolean }>,
    invalidRecords: SQSBatchItemFailure[],
    requestIds: string[]
  ): SQSBatchResponse {
    const failures = [...invalidRecords];
    results.forEach((result) => {
      if (!result.success) {
        failures.push({ itemIdentifier: result.messageId });
      }
    });

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    logger.info(
      {
        total: results.length,
        success: successCount,
        failed: failureCount,
        requestIds: requestIds.length > 0 ? requestIds : undefined,
      },
      "Batch processing completed"
    );

    if (failures.length) {
      logger.warn({ failed: failures.length }, "Batch completed with failures");
    } else {
      logger.info("Batch completed successfully");
    }

    return { batchItemFailures: failures };
  }

  private createFailureResponseForAllRecords(
    records: any[]
  ): SQSBatchResponse {
    return {
      batchItemFailures: records.map((record) => ({
        itemIdentifier: record.messageId,
      })),
    };
  }

  private setupGracefulShutdownHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn("Shutdown already in progress, ignoring signal");
        return;
      }

      this.isShuttingDown = true;
      logger.info({ signal }, "Received shutdown signal, closing connections...");

      try {
        await this.clientInitializationService.closeClients();
        logger.info("Lambda graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        logger.error({ error }, "Error during Lambda graceful shutdown");
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

    process.on("uncaughtException", async (error) => {
      logger.error({ error }, "Uncaught exception, shutting down gracefully");
      await gracefulShutdown("uncaughtException");
    });

    process.on("unhandledRejection", async (reason, promise) => {
      logger.error(
        { reason, promise },
        "Unhandled rejection, shutting down gracefully"
      );
      await gracefulShutdown("unhandledRejection");
    });
  }
}

function createHandlerService(): SQSHandlerService {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const clientInitializationService =
    createClientInitializationService(region);
  return new SQSHandlerService(clientInitializationService);
}

const handlerService = createHandlerService();

export const handler: SQSHandler = async (event) => {
  return handlerService.handle(event);
};
