import express from "express";
import { makeHelloClient } from "./helloClient";

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

app.listen(PORT, () => {
  console.log(`api listening :${PORT}`);
});