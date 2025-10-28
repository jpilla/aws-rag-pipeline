import { logger } from "./logger.js";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";

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
let prismaClient: PrismaClient | null = null;
let openaiClient: OpenAI | null = null;
let secretsClient: SecretsManagerClient | null = null;
let isInitialized: boolean = false;

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
  const requiredEnvVars = [
    'DB_SECRET_ARN',
    'OPENAI_SECRET_ARN',
    'DB_HOST',
    'DB_NAME'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
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

    // Initialize Secrets Manager client
    secretsClient = new SecretsManagerClient({});

    // Initialize Prisma client
    await initializePrismaClient();

    // Initialize OpenAI client
    await initializeOpenAIClient();

    isInitialized = true;
    logger.info("All Lambda clients initialized successfully");
  } catch (error) {
    logger.error({ error }, "Failed to initialize Lambda clients");
    throw error;
  }
}

async function initializePrismaClient(): Promise<void> {
  if (prismaClient) {
    return;
  }

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DB_SECRET_ARN environment variable not set");
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const secretValue = await secretsClient!.send(command);

  if (!secretValue.SecretString) {
    throw new Error("Failed to retrieve database credentials");
  }

  const credentials = JSON.parse(secretValue.SecretString);

  // Construct DATABASE_URL like the API service does
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'embeddings';
  const databaseUrl = `postgresql://${credentials.username}:${credentials.password}@${host}:${port}/${database}?sslmode=require`;

  prismaClient = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
    log: ['error', 'warn'],
  });

  // Test the connection
  try {
    await prismaClient.$queryRaw`SELECT 1`;
    logger.info({ databaseUrl: databaseUrl.replace(/:[^:]*@/, ':***@') }, "Prisma client initialized and connected");
  } catch (connectionError) {
    logger.error({
      error: connectionError,
      databaseUrl: databaseUrl.replace(/:[^:]*@/, ':***@')
    }, "Failed to connect to database");
    throw new Error(`Database connection failed: ${connectionError}`);
  }
}

async function initializeOpenAIClient(): Promise<void> {
  if (openaiClient) {
    return;
  }

  const secretArn = process.env.OPENAI_SECRET_ARN;
  if (!secretArn) {
    throw new Error("OPENAI_SECRET_ARN environment variable not set");
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const secretValue = await secretsClient!.send(command);

  if (!secretValue.SecretString) {
    throw new Error("Failed to retrieve OpenAI API key");
  }

  const apiKey = secretValue.SecretString;

  openaiClient = new OpenAI({
    apiKey: apiKey,
  });

  logger.info("OpenAI client initialized");
}

async function getPrismaClient(): Promise<PrismaClient> {
  if (!prismaClient) {
    await initializePrismaClient();
  }
  return prismaClient!;
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

  if (prismaClient) {
    closePromises.push(
      prismaClient.$disconnect().then(() => {
        logger.info("Prisma client disconnected");
        prismaClient = null;
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

  const prisma = await getPrismaClient();
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

    await prisma.$transaction(async (tx: any) => {
      // Insert placeholder embeddings first (required for FK)
      await tx.$executeRaw`
        INSERT INTO "Embedding" ("contentHash", embedding, "createdAt")
        SELECT
          unnest(${contentHashes}::text[]) as "contentHash",
          NULL as embedding,
          NOW() as "createdAt"
        ON CONFLICT ("contentHash") DO NOTHING
      `;

      // Insert chunks with ENQUEUED status
      await tx.$executeRaw`
        INSERT INTO "Chunk" (id, "contentHash", "batchId", "clientId", "chunkIndex", content, status, "createdAt", "updatedAt")
        SELECT
          unnest(${chunkIds}::text[]) as id,
          unnest(${contentHashes}::text[]) as "contentHash",
          unnest(${batchIds}::text[]) as "batchId",
          unnest(${clientIds}::text[]) as "clientId",
          unnest(${chunkIndexes}::int[]) as "chunkIndex",
          unnest(${contents}::text[]) as content,
          'ENQUEUED' as status,
          NOW() as "createdAt",
          NOW() as "updatedAt"
        ON CONFLICT ("contentHash", "batchId") DO NOTHING
      `;
    });

    logger.info({ recordCount: processedRecords.length }, "Batch inserted chunks and placeholder embeddings");

    // Phase 2: Check which embeddings need computation (outside transaction)
    logger.info({ contentHashes }, "Phase 2: Checking which embeddings need computation");

    const existingEmbeddings = await prisma.$queryRaw<Array<{ contentHash: string; embedding: any }>>`
      SELECT "contentHash", embedding::text as embedding FROM "Embedding"
      WHERE "contentHash" = ANY(${contentHashes}) AND embedding IS NOT NULL
    `;

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
          await prisma.$executeRaw`
            UPDATE "Chunk"
            SET status = 'FAILED', "failureReason" = 'COMPUTE_EMBEDDINGS_FAILURE', "updatedAt" = NOW()
            WHERE id = ANY(${failedChunkIds})
          `;
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
      await prisma.$transaction(async (tx: any) => {
        // Update embeddings if we generated new ones
        if (embeddings && recordsToProcess.length > 0) {
          const contentHashes = recordsToProcess.map(record => record.contentHash);
          const embeddingStrings = embeddings.map(embedding => `[${embedding.join(',')}]`);

          // Use subquery with unnest - avoids the UPDATE restriction
          await tx.$executeRaw`
            UPDATE "Embedding"
            SET embedding = subq.embedding
            FROM (
              SELECT
                unnest(${contentHashes}::text[]) as "contentHash",
                unnest(${embeddingStrings}::vector[]) as embedding
            ) AS subq
            WHERE "Embedding"."contentHash" = subq."contentHash"
          `;

          logger.info({ updatedEmbeddings: recordsToProcess.length }, "Updated embeddings");
        }

        // Update all chunks to INGESTED status
        await tx.$executeRaw`
          UPDATE "Chunk"
          SET status = 'INGESTED', "updatedAt" = NOW()
          WHERE "contentHash" = ANY(${contentHashes})
        `;
      });

      logger.info({ updatedCount: contentHashes.length }, "Batch updated chunk status to INGESTED");

    } catch (dbError) {
      logger.error({ error: dbError, recordCount: records.length }, "Database update failed - marking chunks as FAILED");

      // Update failed chunks (short transaction)
      const failedChunkIds = processedRecords.map(record => record.chunkId);
      try {
        await prisma.$executeRaw`
          UPDATE "Chunk"
          SET status = 'FAILED', "failureReason" = 'DATA_LAYER_FAILURE', "updatedAt" = NOW()
          WHERE id = ANY(${failedChunkIds})
        `;
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
