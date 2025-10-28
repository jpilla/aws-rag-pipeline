import express from "express";
import healthRoutes from "./routes/health.routes";
import ingestRoutes from "./routes/ingest.routes";
import queryRoutes from "./routes/query.routes";
import { requestIdMiddleware } from "./middleware/requestId";
import { commonValidationMiddleware } from "./middleware/validation";
import { logger } from "./lib/logger";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');

app.get("/", (_req, res) => res.json({ message: "hello world!" }));

app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

app.use(commonValidationMiddleware);
app.use(requestIdMiddleware);

app.use(healthRoutes);
app.use(ingestRoutes);
app.use(queryRoutes);

app.listen(PORT, () => {
  logger.info({ port: PORT }, "API server started");
});
