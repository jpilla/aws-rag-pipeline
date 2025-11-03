import express from "express";
import healthRoutes from "./routes/health.routes";
import ingestRoutes from "./routes/ingest.routes";
import queryRoutes from "./routes/query.routes";
import { requestIdMiddleware } from "./middleware/requestId";
import { commonValidationMiddleware } from "./middleware/validation";
import { logger } from "./lib/logger";
import { prismaService } from "./lib/prisma-client";
import { openaiService } from "./services/openai.service";
import { initializeIngestService } from "./routes/ingest.routes";

const app = express();
const PORT = Number(process.env.PORT || 3000);
let server: any = null; // Store server reference for graceful shutdown
let isShuttingDown = false; // Flag to prevent concurrent shutdown attempts
const activeConnections = new Set<any>(); // Track active HTTP connections

app.disable('x-powered-by');

app.get("/", (_req, res) => res.json({ message: "hello world!" }));

app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

app.use(commonValidationMiddleware);
app.use(requestIdMiddleware);

// Track active connections to wait for them during graceful shutdown
app.use((req, res, next) => {
  activeConnections.add(res);
  res.on('finish', () => {
    activeConnections.delete(res);
  });
  res.on('close', () => {
    activeConnections.delete(res);
  });
  next();
});

app.use(healthRoutes);
app.use(ingestRoutes);
app.use(queryRoutes);

/**
 * Validate required environment variables at startup
 */
function validateEnvironment(): void {
  const requiredEnvVars = [
    'DB_HOST',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  logger.info("Environment variables validated");
}

/**
 * Initialize external clients before starting the server
 * This ensures clients are ready before serving traffic
 */
async function initializeClients(): Promise<void> {
  logger.info("Initializing external clients...");

  try {
    // Validate environment first
    validateEnvironment();
    // Initialize Prisma client and test connection
    await prismaService.getClient();
    const dbTest = await prismaService.testConnection();
    if (!dbTest.success) {
      throw new Error(`Database connection failed: ${dbTest.message}`);
    }
    logger.info("Prisma client initialized and connected");

    // Initialize OpenAI client
    await openaiService.getClient();
    logger.info("OpenAI client initialized");

    // Initialize ingest service (SQS client)
    await initializeIngestService();
    logger.info("Ingest service (SQS client) initialized");

    logger.info("All external clients initialized successfully");
  } catch (error) {
    logger.error({ error }, "Failed to initialize external clients");
    throw error;
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    logger.warn("Shutdown already in progress, ignoring signal");
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, "Received shutdown signal, starting graceful shutdown...");

  // Set a timeout to force exit if graceful shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    logger.error("Graceful shutdown timeout (25s), forcing exit");
    process.exit(1);
  }, 25000); // 25 seconds, leave 5s buffer before ECS SIGKILL

  try {
    // Step 1: Stop accepting new connections
    if (server) {
      logger.info("Closing HTTP server to new connections...");

      // Wrap server.close() in a promise to properly await it
      await new Promise<void>((resolve, reject) => {
        server.close((err: Error | undefined) => {
          if (err) {
            logger.error({ error: err }, "Error closing HTTP server");
            reject(err);
          } else {
            logger.info("HTTP server closed, no longer accepting new connections");
            resolve();
          }
        });
      });

      // Step 2: Wait for active connections to finish
      // Note: ALB should have stopped routing new requests to this task.
      // We wait for in-flight requests to complete naturally.
      const activeConnectionsCount = activeConnections.size;
      if (activeConnectionsCount > 0) {
        logger.info({ activeConnections: activeConnectionsCount }, "Waiting for active connections to finish...");

        // Wait for all connections to finish (will be interrupted by overall timeout if needed)
        while (activeConnections.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        logger.info("All active connections closed");
      }
    }

    // Step 3: Close database connections
    logger.info("Closing database connections...");
    await prismaService.close();
    logger.info("Database connections closed");

    // Clear the timeout since we completed successfully
    clearTimeout(shutdownTimeout);

    logger.info("Graceful shutdown completed successfully");
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Error during graceful shutdown");
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
// Note: These would crash the process anyway. We handle them here to ensure
// cleanup (DB connections, in-flight requests) happens before exit.
// Express does NOT handle these automatically - the process would exit immediately
// without cleanup if we didn't catch them here.
process.on('uncaughtException', async (error) => {
  logger.error({ error, stack: error.stack }, "Uncaught exception, shutting down gracefully");
  await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled rejection, shutting down gracefully");
  await gracefulShutdown('unhandledRejection');
});

// Start server after initializing clients
async function startServer(): Promise<void> {
  try {
    await initializeClients();

    server = app.listen(PORT, () => {
      logger.info({ port: PORT }, "API server started and ready to serve traffic");
    });
  } catch (error) {
    logger.error({ error }, "Failed to start server");
    process.exit(1);
  }
}

startServer();
