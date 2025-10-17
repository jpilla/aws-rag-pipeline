import express from "express";
import healthRoutes from "./routes/health.routes";
import ingestRoutes from "./routes/ingest.routes";
import embeddingsRoutes from "./routes/embeddings.routes";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Root endpoint
app.get("/", (_req, res) => res.json({ message: "hello world!" }));

// Middleware for JSON parsing (must be before routes that use it)
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));

// Mount route handlers
app.use(healthRoutes);
app.use(ingestRoutes);
app.use(embeddingsRoutes);

app.listen(PORT, () => {
  console.log(`api listening :${PORT}`);
});