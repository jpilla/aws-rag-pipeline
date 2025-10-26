import { logger } from "./logger.js";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import crypto from "crypto";

export type Payload = {
  chunkId: string;
  clientId: string;
  content: any;
  metadata: Record<string, any>;
  batchId: string;
  enqueuedAt: string;
};

let prismaClient: PrismaClient | null = null;
let openaiClient: OpenAI | null = null;

async function getPrismaClient(): Promise<PrismaClient> {
  if (prismaClient) {
    return prismaClient;
  }

  const secretsClient = new SecretsManagerClient({});
  const secretArn = process.env.DB_SECRET_ARN;

  if (!secretArn) {
    throw new Error("DB_SECRET_ARN environment variable not set");
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const secretValue = await secretsClient.send(command);

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

  return prismaClient;
}

async function getOpenAIClient(): Promise<OpenAI> {
  if (openaiClient) {
    return openaiClient;
  }

  const secretsClient = new SecretsManagerClient({});
  const secretArn = process.env.OPENAI_SECRET_ARN;

  if (!secretArn) {
    throw new Error("OPENAI_SECRET_ARN environment variable not set");
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const secretValue = await secretsClient.send(command);

  if (!secretValue.SecretString) {
    throw new Error("Failed to retrieve OpenAI API key");
  }

  const apiKey = secretValue.SecretString;

  openaiClient = new OpenAI({
    apiKey: apiKey,
  });

  logger.info("OpenAI client initialized");
  return openaiClient;
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
    // Pre-process all records (chunkId already computed by API)
    const processedRecords = records.map(record => {
      const content = typeof record.payload.content === 'string'
        ? record.payload.content
        : JSON.stringify(record.payload.content);
      // chunkId is already computed by the API service
      const chunkId = record.payload.chunkId;

      return {
        ...record,
        processedContent: content,
        chunkId
      };
    });

    // Phase 1: Insert all records with ENQUEUED status (idempotent via contentHash)
    logger.info({ recordCount: records.length }, "Phase 1: Inserting records with ENQUEUED status");

    // Prepare batch insert data
    const insertData = processedRecords.map(record => ({
      chunkId: record.chunkId,
      clientId: record.payload.clientId,
      content: record.processedContent,
      originalRecord: record
    }));

    // Batch insert using Prisma's createMany equivalent with raw SQL
    try {
      // Use unnest for efficient batch insert
      const chunkIds = insertData.map(d => d.chunkId);
      const clientIds = insertData.map(d => d.clientId);
      const chunkIndexes = insertData.map(() => 0);
      const contents = insertData.map(d => d.content);

      await prisma.$executeRaw`
        INSERT INTO "Embedding" (id, "docId", "chunkIndex", content, status, "createdAt", "updatedAt")
        SELECT
          unnest(${chunkIds}::text[]) as id,
          unnest(${clientIds}::text[]) as "docId",
          unnest(${chunkIndexes}::int[]) as "chunkIndex",
          unnest(${contents}::text[]) as content,
          'ENQUEUED' as status,
          NOW() as "createdAt",
          NOW() as "updatedAt"
        ON CONFLICT (id) DO NOTHING
      `;

      logger.info({ recordCount: insertData.length }, "Batch inserted records with ENQUEUED status");
    } catch (dbError) {
      logger.error({ error: dbError, recordCount: insertData.length }, "Failed to batch insert records");
      // Continue processing - individual records might still exist
    }

    // Phase 2: Check which records need processing
    const chunkIds = processedRecords.map(record => record.chunkId);

    logger.info({ chunkIds }, "Phase 2: Checking which records need processing");

    const existingRecords = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "Embedding"
      WHERE id = ANY(${chunkIds})
    `;

    const alreadyIngestedIds = new Set(
      existingRecords
        .filter((record: { id: string; status: string }) => record.status === 'INGESTED')
        .map((record: { id: string; status: string }) => record.id)
    );

    const recordsToProcess = processedRecords.filter(record =>
      !alreadyIngestedIds.has(record.chunkId)
    );

    logger.info({
      totalRecords: records.length,
      alreadyIngested: alreadyIngestedIds.size,
      needProcessing: recordsToProcess.length
    }, "Processing status analysis");

    // Short circuit if all already ingested
    if (recordsToProcess.length === 0) {
      logger.info({ recordCount: records.length }, "All chunks already ingested, skipping OpenAI processing");

      processedRecords.forEach(record => {
        results.push({
          messageId: record.messageId,
          payload: record.payload,
          success: true,
        });
      });

      return results;
    }

    // Phase 3: Process remaining records with OpenAI (batched)
    logger.info({
      recordsToProcess: recordsToProcess.length,
      skippedRecords: records.length - recordsToProcess.length
    }, "Phase 3: Processing remaining records with OpenAI (batched)");

    if (recordsToProcess.length > 0) {
      try {
        // Prepare all contents for batch embedding generation
        const contents = recordsToProcess.map(record => record.processedContent);

        logger.info({ contentCount: contents.length }, "Generating embeddings batch");
        const embeddings = await generateEmbeddings(contents);

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

        // Batch update all records to INGESTED status using UPDATE FROM
        const chunkIds = recordsToProcess.map(record => record.chunkId);
        const embeddingStrings = embeddings.map(embedding => `[${embedding.join(',')}]`);

        await prisma.$executeRaw`
          UPDATE "Embedding"
          SET embedding = updates.embedding,
              status = 'INGESTED',
              "updatedAt" = NOW()
          FROM (
            SELECT
              unnest(${chunkIds}::text[]) as id,
              unnest(${embeddingStrings}::vector[]) as embedding
          ) AS updates
          WHERE "Embedding".id = updates.id
        `;

        logger.info({ updatedCount: chunkIds.length }, "Batch updated records to INGESTED status");

        // Add successful results
        const updateResults = recordsToProcess.map(record => ({
          messageId: record.messageId,
          payload: record.payload,
          success: true,
        }));

        results.push(...updateResults);

        logger.info({
          processedCount: updateResults.length,
          successCount: updateResults.filter(r => r.success).length
        }, "Batch embedding processing completed");

      } catch (openaiError) {
        logger.error({ error: openaiError, recordCount: recordsToProcess.length }, "OpenAI batch processing failed - marking all as FAILED");

        // Batch update all records to FAILED status
        const chunkIds = recordsToProcess.map(record => record.chunkId);

        await prisma.$executeRaw`
          UPDATE "Embedding"
          SET status = 'FAILED', "updatedAt" = NOW()
          WHERE id = ANY(${chunkIds})
        `;

        logger.info({ failedCount: chunkIds.length }, "Batch updated records to FAILED status");

        // Add failed results
        const failedResults = recordsToProcess.map(record => ({
          messageId: record.messageId,
          payload: record.payload,
          success: false,
          error: openaiError instanceof Error ? openaiError.message : 'OpenAI batch processing failed',
        }));

        results.push(...failedResults);
      }
    }

    // Add already ingested records as successful
    processedRecords.forEach(record => {
      if (alreadyIngestedIds.has(record.chunkId)) {
        results.push({
          messageId: record.messageId,
          payload: record.payload,
          success: true,
        });
      }
    });

    logger.info({
      recordCount: records.length,
      successCount: results.length,
      alreadyIngested: alreadyIngestedIds.size,
      newlyProcessed: results.filter(r => r.success).length - alreadyIngestedIds.size,
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
