import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import { logger } from "../logger.js";

export interface ClientInitializationService {
  initializePrismaClient(): Promise<PrismaClient>;
  initializeOpenAIClient(): Promise<OpenAI>;
  closeClients(): Promise<void>;
}

export class AwsClientInitializationService
  implements ClientInitializationService
{
  private prismaClient: PrismaClient | null = null;
  private openaiClient: OpenAI | null = null;
  private secretsClient: SecretsManagerClient | null = null;

  constructor(private region: string) {
    this.secretsClient = new SecretsManagerClient({ region });
  }

  async initializePrismaClient(): Promise<PrismaClient> {
    if (this.prismaClient) {
      return this.prismaClient;
    }

    const secretArn = process.env.DB_SECRET_ARN;
    if (!secretArn) {
      throw new Error("DB_SECRET_ARN environment variable not set");
    }

    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const secretValue = await this.secretsClient!.send(command);

    if (!secretValue.SecretString) {
      throw new Error("Failed to retrieve database credentials");
    }

    const credentials = JSON.parse(secretValue.SecretString);
    const host = process.env.DB_HOST || "localhost";
    const port = process.env.DB_PORT || "5432";
    const database = process.env.DB_NAME || "embeddings";
    const databaseUrl = `postgresql://${credentials.username}:${credentials.password}@${host}:${port}/${database}?sslmode=require`;

    this.prismaClient = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
      log: ["error", "warn"],
    });

    await this.testPrismaConnection(databaseUrl);
    return this.prismaClient;
  }

  private async testPrismaConnection(databaseUrl: string): Promise<void> {
    try {
      await this.prismaClient!.$queryRaw`SELECT 1`;
      logger.info(
        { databaseUrl: databaseUrl.replace(/:[^:]*@/, ":***@") },
        "Prisma client initialized and connected"
      );
    } catch (connectionError) {
      logger.error(
        {
          error: connectionError,
          databaseUrl: databaseUrl.replace(/:[^:]*@/, ":***@"),
        },
        "Failed to connect to database"
      );
      throw new Error(`Database connection failed: ${connectionError}`);
    }
  }

  async initializeOpenAIClient(): Promise<OpenAI> {
    if (this.openaiClient) {
      return this.openaiClient;
    }

    const apiKey = await this.retrieveOpenAIKey();
    this.openaiClient = new OpenAI({ apiKey });
    logger.info("OpenAI client initialized");
    return this.openaiClient;
  }

  private async retrieveOpenAIKey(): Promise<string> {
    if (process.env.OPENAI_SECRET_ARN) {
      return await this.retrieveOpenAIKeyFromSecretsManager();
    }

    if (process.env.OPENAI_SECRET) {
      return process.env.OPENAI_SECRET;
    }

    throw new Error(
      "Either OPENAI_SECRET_ARN or OPENAI_SECRET must be set"
    );
  }

  private async retrieveOpenAIKeyFromSecretsManager(): Promise<string> {
    const secretArn = process.env.OPENAI_SECRET_ARN!;
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const secretValue = await this.secretsClient!.send(command);

    if (!secretValue.SecretString) {
      throw new Error("Failed to retrieve OpenAI API key");
    }

    return secretValue.SecretString;
  }

  async closeClients(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    if (this.prismaClient) {
      closePromises.push(
        this.prismaClient
          .$disconnect()
          .then(() => {
            logger.info("Prisma client disconnected");
            this.prismaClient = null;
          })
          .catch((error: any) => {
            logger.error({ error }, "Failed to disconnect Prisma client");
          })
      );
    }

    if (this.openaiClient) {
      this.openaiClient = null;
      logger.info("OpenAI client reference cleared");
    }

    await Promise.all(closePromises);
  }
}

export function createClientInitializationService(
  region: string
): ClientInitializationService {
  return new AwsClientInitializationService(region);
}
