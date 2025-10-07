import express from "express";
import { makeHelloClient } from "./helloClient";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import crypto from "crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const hello = makeHelloClient();

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api" }));

app.get("/readyz", async (_req, res) => {
  try {
    let helloHealth = await hello.health();
    res.json({ ready: true , via: helloHealth.via});
  } catch (err: any) {
    res.status(503).json({
      ready: false,
      reason: err?.message ?? "unknown",
      target: process.env.HELLO_URL,
    });
  }
});

app.get("/", (_req, res) => res.json({ message: "hello world!" }));

const QUEUE_URL = process.env.INGEST_QUEUE_URL!;
const sqs = new SQSClient({ region: process.env.AWS_REGION });

// must be BEFORE app.post("/v1/ingest", ...)
app.use(express.json({ limit: "10mb", type: ["application/json", "application/*+json"] }));
app.post("/v1/ingest", async (req, res) => {
  if (!QUEUE_URL) return res.status(500).json({ error: "INGEST_QUEUE_URL not set" });

  const { records } = req.body;
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: "records[] required" });
  }

  const batchId = `b_${crypto.randomUUID()}`;
  const results: any[] = [];
  const errors: any[] = [];

  for (let i = 0; i < records.length; i += 10) {
    const slice = records.slice(i, i + 10);
    const entries = slice.map((r: any, idx: number) => {
      const chunkId = r.chunkId ?? `c_${crypto.randomUUID()}`;
      const body = JSON.stringify({
        chunkId,
        clientId: r.clientId,
        content: r.content,
        metadata: r.metadata ?? {},
        batchId,
        enqueuedAt: new Date().toISOString(),
      });
      return { Id: chunkId, MessageBody: body, _meta: { chunkId, clientId: r.clientId, idx: i + idx } };
    });

    try {
      const resp = await sqs.send(
        new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries })
      );

      resp.Successful?.forEach((s) => {
        const m = entries.find((e) => e.Id === s.Id)!;
        results.push({
          clientId: m._meta.clientId,
          originalIndex: m._meta.idx,
          chunkId: m._meta.chunkId,
          messageId: s.MessageId,
          status: "enqueued",
        });
      });

      resp.Failed?.forEach((f) => {
        const m = entries.find((e) => e.Id === f.Id)!;
        errors.push({
          clientId: m._meta.clientId,
          originalIndex: m._meta.idx,
          chunkId: m._meta.chunkId,
          status: "rejected",
          code: f.Code,
          message: f.Message,
        });
      });
    } catch (e: any) {
      slice.forEach((r: any, idx: number) =>
        errors.push({
          clientId: r.clientId,
          originalIndex: i + idx,
          status: "rejected",
          code: "BatchError",
          message: e.message ?? String(e),
        })
      );
    }
  }

  const summary = { received: records.length, enqueued: results.length, rejected: errors.length };
  const status = results.length ? 202 : 503;
  res.status(status).json({ batchId, summary, results, errors });
});

app.listen(PORT, () => {
  console.log(`api listening :${PORT}`);
});