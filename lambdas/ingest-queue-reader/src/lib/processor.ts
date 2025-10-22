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

  logger.info("Prisma client initialized");
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

async function generateEmbedding(content: string): Promise<number[]> {
  const openai = await getOpenAIClient();

  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: content,
    });

    return response.data[0].embedding;
  } catch (error) {
    logger.error({ error, content: content.substring(0, 100) }, "Failed to generate embedding");
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
    // Generate embeddings for all records in parallel
    logger.info({ recordCount: records.length }, "Generating embeddings for batch");

    const embeddingPromises = records.map(async (record, index) => {
      const content = typeof record.payload.content === 'string'
        ? record.payload.content 
        : JSON.stringify(record.payload.content);

      // Generate embedding using OpenAI
      const embedding = await generateEmbedding(content);

      return {
        id: record.payload.chunkId || record.messageId,
        docId: record.payload.clientId, // Use clientId as docId
        chunkIndex: index, // Simple auto-increment for each record in the batch
        content: content,
        embedding: embedding,
      };
    });

    // Wait for all embeddings to be generated
    const embeddingData = await Promise.all(embeddingPromises);

    // Log all record fields before database insert
    logger.info({ 
      recordCount: embeddingData.length,
      records: embeddingData.map((data, index) => ({
        index,
        id: data.id,
        docId: data.docId,
        chunkIndex: data.chunkIndex,
        contentLength: data.content.length,
        embeddingLength: data.embedding.length,
        contentPreview: data.content.substring(0, 100) + (data.content.length > 100 ? '...' : ''),
        embeddingPreview: data.embedding.slice(0, 5) // Show first 5 embedding values
      }))
    }, "About to insert records into database");
    
    // Use a transaction to insert all records at once
    await prisma.$transaction(async (tx: any) => {
      await tx.embedding.createMany({
        data: embeddingData,
        skipDuplicates: true, // Skip duplicates instead of failing
      });
    });
    
    // All records succeeded
    records.forEach(record => {
      results.push({
        messageId: record.messageId,
        payload: record.payload,
        success: true,
      });
    });
    
    logger.info({ 
      recordCount: records.length,
      successCount: results.length 
    }, "Successfully processed batch");
    
  } catch (error) {
    logger.error({ error, recordCount: records.length }, "Batch processing failed - marking all records as failed");
    
    // If the transaction fails, mark all records as failed
    records.forEach(record => {
      results.push({
        messageId: record.messageId,
        payload: record.payload,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });
  }
  
  return results;
}