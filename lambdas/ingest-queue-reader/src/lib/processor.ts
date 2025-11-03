import { logger } from "./logger.js";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import OpenAI from "openai";
import {
  PrismaService,
  SecretsManagerCredentialProvider,
  SqlQueries,
} from "../../../../lib/shared-prisma/src/index.js";

export type Payload = {
  chunkId: string;
  clientId: string;
  content: any;
  metadata: Record<string, any>;
  batchId: string;
  enqueuedAt: string;
  contentHash: string;
  originalIndex: number;
};

// Global client instances - initialized once per Lambda container
let prismaService: PrismaService | null = null;
let openaiClient: OpenAI | null = null;
let secretsClient: SecretsManagerClient | null = null;
let sqlQueries: SqlQueries | null = null;
let isInitialized: boolean = false;

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const requiredEnvVars = [
    'DB_SECRET_ARN',
    'DB_HOST',
    'DB_NAME'
  ];

  // OPENAI can come from OPENAI_SECRET_ARN (production) or OPENAI_SECRET (local dev)
  const hasOpenAI = !!(process.env.OPENAI_SECRET_ARN || process.env.OPENAI_SECRET);

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  if (!hasOpenAI) {
    throw new Error('Missing OpenAI configuration: either OPENAI_SECRET_ARN or OPENAI_SECRET must be set');
  }

  logger.info("Lambda environment variables validated");
}

/**
 * Initialize all clients once per Lambda container
 * This runs outside the handler to minimize cold start latency
 */
export async function initializeClients(): Promise<void> {
  if (isInitialized) {
    return;
  }

  logger.info("Initializing Lambda clients...");

  try {
    // Validate environment first
    validateEnvironment();

    // Initialize Secrets Manager client with region
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error("AWS_REGION or AWS_DEFAULT_REGION must be set");
    }
    secretsClient = new SecretsManagerClient({ region });

    // Initialize Prisma service with Secrets Manager credential provider
    const secretArn = process.env.DB_SECRET_ARN;
    if (!secretArn) {
      throw new Error("DB_SECRET_ARN environment variable not set");
    }

    sqlQueries = new SqlQueries();
    const credentialProvider = new SecretsManagerCredentialProvider(secretsClient, secretArn);
    prismaService = new PrismaService(credentialProvider, sqlQueries);

    // Initialize Prisma client and test connection
    const client = await prismaService.getClient();
    await client.$queryRaw`SELECT 1`;
    logger.info("Prisma client initialized and connected");

    // Initialize OpenAI client
    await initializeOpenAIClient();

    isInitialized = true;
    logger.info("All Lambda clients initialized successfully");
  } catch (error) {
    logger.error({ error }, "Failed to initialize Lambda clients");
    throw error;
  }
}

async function initializeOpenAIClient(): Promise<void> {
  if (openaiClient) {
    return;
  }

  let apiKey: string;

  // Support both production (Secrets Manager) and local development (direct env var)
  if (process.env.OPENAI_SECRET_ARN) {
    // Production mode: fetch from Secrets Manager
    const secretArn = process.env.OPENAI_SECRET_ARN;
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const secretValue = await secretsClient!.send(command);

    if (!secretValue.SecretString) {
      throw new Error("Failed to retrieve OpenAI API key");
    }

    apiKey = secretValue.SecretString;
  } else if (process.env.OPENAI_SECRET) {
    // Local development mode: use environment variable directly
    apiKey = process.env.OPENAI_SECRET;
  } else {
    throw new Error("Either OPENAI_SECRET_ARN or OPENAI_SECRET must be set");
  }

  openaiClient = new OpenAI({
    apiKey: apiKey,
  });

  logger.info("OpenAI client initialized");
}

async function getPrismaService(): Promise<PrismaService> {
  if (!prismaService) {
    await initializeClients();
  }
  return prismaService!;
}

async function getOpenAIClient(): Promise<OpenAI> {
  if (!openaiClient) {
    await initializeOpenAIClient();
  }
  return openaiClient!;
}

/**
 * Gracefully close all client connections
 */
export async function closeClients(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  if (prismaService) {
    closePromises.push(
      prismaService.close().then(() => {
        logger.info("Prisma client disconnected");
        prismaService = null;
      }).catch((error: any) => {
        logger.error({ error }, "Failed to disconnect Prisma client");
      })
    );
  }

  // OpenAI client doesn't need explicit cleanup, but we can reset the reference
  if (openaiClient) {
    openaiClient = null;
    logger.info("OpenAI client reference cleared");
  }

  await Promise.all(closePromises);
}

async function generateEmbeddings(contents: string[]): Promise<number[][]> {
  const openai = await getOpenAIClient();

  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: contents,
    });

    return response.data.map(item => item.embedding);
  } catch (error) {
    logger.error({ error, contentCount: contents.length }, "Failed to generate embeddings batch");
    throw error;
  }
}

export type ProcessedRecord = {
  messageId: string;
  payload: Payload;
  success: boolean;
  error?: string;
};

export async function processBatch(records: Array<{ messageId: string; payload: Payload }>): Promise<ProcessedRecord[]> {
  logger.info({ recordCount: records.length }, "Processing batch of SQS messages");

  const prisma = await getPrismaService();
  const client = await prisma.getClient();
  const queries = sqlQueries!;
  const results: ProcessedRecord[] = [];

  try {
    // Pre-process all records using pre-computed contentHash from API
    const processedRecords = records.map(record => {
      const content = typeof record.payload.content === 'string'
        ? record.payload.content
        : JSON.stringify(record.payload.content);

      const chunkId = record.payload.chunkId;
      const contentHash = record.payload.contentHash; // Use pre-computed hash from API

      return {
        ...record,
        processedContent: content,
        chunkId,
        contentHash
      };
    });

    // Phase 1: Insert chunks and placeholder embeddings (short transaction)
    logger.info({ recordCount: records.length }, "Phase 1: Inserting chunks and placeholder embeddings");

    const contentHashes = processedRecords.map(record => record.contentHash);
    const chunkIds = processedRecords.map(record => record.chunkId);
    const batchIds = processedRecords.map(record => record.payload.batchId);
    const clientIds = processedRecords.map(record => record.payload.clientId);
    const chunkIndexes = processedRecords.map(record => record.payload.originalIndex);
    const contents = processedRecords.map(record => record.processedContent);

    await client.$transaction(async (tx: any) => {
      // Insert placeholder embeddings first (required for FK)
      await queries.insertPlaceholderEmbeddings(tx, contentHashes);

      // Insert chunks with ENQUEUED status
      await queries.insertChunks(tx, chunkIds, contentHashes, batchIds, clientIds, chunkIndexes, contents);
    });

    logger.info({ recordCount: processedRecords.length }, "Batch inserted chunks and placeholder embeddings");

    // Phase 2: Check which embeddings need computation (outside transaction)
    logger.info({ contentHashes }, "Phase 2: Checking which embeddings need computation");

    const existingEmbeddings = await queries.getExistingEmbeddings(client, contentHashes);

    const existingContentHashes = new Set(
      existingEmbeddings.map((record: { contentHash: string }) => record.contentHash)
    );

    const recordsToProcess = processedRecords.filter(record =>
      !existingContentHashes.has(record.contentHash)
    );

    logger.info({
      totalRecords: records.length,
      alreadyIngested: existingContentHashes.size,
      needProcessing: recordsToProcess.length
    }, "Processing status analysis");

    // Phase 3: Generate embeddings for new content (if needed)
    let embeddings: number[][] | null = null;

    if (recordsToProcess.length > 0) {
      logger.info({
        recordsToProcess: recordsToProcess.length,
        skippedRecords: records.length - recordsToProcess.length
      }, "Phase 3: Generating embeddings for new content");

      try {
        // Prepare all contents for batch embedding generation
        const contents = recordsToProcess.map(record => record.processedContent);

        logger.info({ contentCount: contents.length }, "Generating embeddings batch");
        embeddings = await generateEmbeddings(contents);

        // Validate embeddings batch
        if (!embeddings || embeddings.length !== contents.length) {
          throw new Error(`Embedding batch size mismatch: expected ${contents.length}, got ${embeddings?.length || 0}`);
        }

        // Validate all embeddings first
        for (let i = 0; i < embeddings.length; i++) {
          const embedding = embeddings[i];
          const chunkId = recordsToProcess[i].chunkId;

          if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
            throw new Error(`Invalid embedding data for chunk ${chunkId}: ${JSON.stringify(embedding)}`);
          }

          const hasInvalidValues = embedding.some(val => !Number.isFinite(val));
          if (hasInvalidValues) {
            throw new Error(`Embedding contains invalid values for chunk ${chunkId}: ${embedding.slice(0, 10)}`);
          }
        }

        logger.info({ generatedCount: embeddings.length }, "Embeddings generated successfully");

      } catch (embeddingError) {
        logger.error({ error: embeddingError, recordCount: recordsToProcess.length }, "Embedding generation failed - marking chunks as FAILED");

        // Update failed chunks (short transaction)
        const failedChunkIds = recordsToProcess.map(record => record.chunkId);
        try {
          await queries.updateChunksToFailed(client, failedChunkIds, 'COMPUTE_EMBEDDINGS_FAILURE');
        } catch (updateError) {
          logger.error({ error: updateError }, "Failed to update chunk status to FAILED");
        }

        // Add failed results
        recordsToProcess.forEach(record => {
          results.push({
            messageId: record.messageId,
            payload: record.payload,
            success: false,
            error: embeddingError instanceof Error ? embeddingError.message : 'Embedding generation failed',
          });
        });

        return results;
      }
    } else {
      logger.info({ recordCount: records.length }, "All embeddings already exist, skipping generation");
    }

    // Phase 4: Update database (embeddings + chunk status)
    logger.info({
      recordCount: records.length,
      hasNewEmbeddings: embeddings !== null
    }, "Phase 4: Updating database");

    try {
      await client.$transaction(async (tx: any) => {
        // Update embeddings if we generated new ones
        if (embeddings && recordsToProcess.length > 0) {
          const contentHashes = recordsToProcess.map(record => record.contentHash);
          const embeddingStrings = embeddings.map(embedding => `[${embedding.join(',')}]`);

          await queries.updateEmbeddings(tx, contentHashes, embeddingStrings);

          logger.info({ updatedEmbeddings: recordsToProcess.length }, "Updated embeddings");
        }

        // Update all chunks to INGESTED status
        await queries.updateChunksToIngested(tx, contentHashes);
      });

      logger.info({ updatedCount: contentHashes.length }, "Batch updated chunk status to INGESTED");

    } catch (dbError) {
      logger.error({ error: dbError, recordCount: records.length }, "Database update failed - marking chunks as FAILED");

      // Update failed chunks (short transaction)
      const failedChunkIds = processedRecords.map(record => record.chunkId);
      try {
        await queries.updateChunksToFailed(client, failedChunkIds, 'DATA_LAYER_FAILURE');
      } catch (updateError) {
        logger.error({ error: updateError }, "Failed to update chunk status to FAILED");
      }

      // Add failed results
      records.forEach(record => {
        results.push({
          messageId: record.messageId,
          payload: record.payload,
          success: false,
          error: dbError instanceof Error ? dbError.message : 'Database update failed',
        });
      });

      return results;
    }

    // Add successful results for all records
    processedRecords.forEach(record => {
      results.push({
        messageId: record.messageId,
        payload: record.payload,
        success: true,
      });
    });

    logger.info({
      recordCount: records.length,
      successCount: results.length,
      failed: results.filter(r => !r.success).length
    }, "Batch processing completed");

  } catch (error) {
    logger.error({ error, recordCount: records.length }, "Critical batch processing failure - marking all records as failed");

    // If critical failure (database connection, etc.), mark all records as failed
    records.forEach(record => {
      results.push({
        messageId: record.messageId,
        payload: record.payload,
        success: false,
        error: error instanceof Error ? error.message : 'Critical processing failure',
      });
    });
  }

  return results;
}
