import { Router } from "express";
import { makeHelloClient } from "../helloClient";
import { databaseService } from "../services/database.service";

const router = Router();
const hello = makeHelloClient();

/**
 * Basic health check endpoint
 */
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "api" });
});

/**
 * Readiness check - verifies downstream dependencies
 */
router.get("/readyz", async (_req, res) => {
  try {
    const helloHealth = await hello.health();
    res.json({ ready: true, via: helloHealth.via });
  } catch (err: any) {
    res.status(503).json({
      ready: false,
      reason: err?.message ?? "unknown",
      target: process.env.HELLO_URL,
    });
  }
});

/**
 * Database health check - tests database connectivity with SELECT 1
 */
router.get("/db-health", async (_req, res) => {
  try {
    const result = await databaseService.testConnection();
    if (result.success) {
      res.json({
        status: "ok",
        message: result.message,
        database: process.env.DB_NAME,
        host: process.env.DB_HOST,
      });
    } else {
      res.status(503).json({
        status: "error",
        message: result.message,
      });
    }
  } catch (err: any) {
    res.status(503).json({
      status: "error",
      message: err?.message ?? "Database connection failed",
    });
  }
});

export default router;

