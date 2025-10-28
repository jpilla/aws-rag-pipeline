import express from "express";
import healthRoutes from "./routes/health.routes";
import ingestRoutes from "./routes/ingest.routes";
import queryRoutes from "./routes/query.routes";
import { requestIdMiddleware } from "./middleware/requestId";
import { logger } from "./lib/logger";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Root endpoint
app.get("/", (_req, res) => res.json({ message: "hello world!" }));

// Middleware for JSON parsing (must be before routes that use it)
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));

// Request ID middleware - apply to all routes
app.use(requestIdMiddleware);

// Mount route handlers
app.use(healthRoutes);
app.use(ingestRoutes);
app.use(queryRoutes);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "API server started");
});
