import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "hello" }));
app.get("/", (_req, res) => res.json({ msg: "hello from private service" }));

app.listen(PORT, () => {
  console.log(`hello listening :${PORT}`);
});