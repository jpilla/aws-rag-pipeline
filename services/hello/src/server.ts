import express from "express";

const app = express();
const port = Number(process.env.APPLICATION_PORT || 3001);

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.json({ msg: "hello from private service" }));

app.listen(port, () => {
  console.log(`hello listening on ${port}`);
});