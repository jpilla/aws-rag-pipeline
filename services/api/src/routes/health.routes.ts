import { Router } from "express";
import { makeHelloClient } from "../helloClient";

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

export default router;

