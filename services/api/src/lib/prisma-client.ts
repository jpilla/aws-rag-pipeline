/**
 * Singleton Prisma service instance for the API
 * Uses EnvVarCredentialProvider (reads DB_USER/DB_PASSWORD from environment)
 */
import { PrismaService, EnvVarCredentialProvider } from '@shared-prisma/index';
import { logger } from './logger';

export const prismaService = new PrismaService(new EnvVarCredentialProvider());

// Add logging hook for initialization
const originalGetClient = prismaService.getClient.bind(prismaService);
prismaService.getClient = async function() {
  const client = await originalGetClient();
  logger.info({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'embeddings'
  }, "Prisma client initialized");
  return client;
};
