#!/usr/bin/env node
/**
 * Stream a large JSONL file and POST batched records to /v1/ingest.
 * - Each JSONL line should look like: { id, embedding_text, ... }
 * - We send { records: [ { clientId, content }, ... ] } in batches.
 * - Concurrency, batch size, retries, and timeouts are configurable.
 * - Deterministic Idempotency-Key per batch -> safe retries.
 *
 * USAGE:
 *   node scripts/ingest_batch_jsonl.js \
 *     --file Amazon_Reviews_Short.jsonl \
 *     --endpoint https://your-api.example.com/v1/ingest \
 *     --batch 100 \
 *     --concurrency 8 \
 *     --retries 6 \
 *     --timeout-ms 60000 \
 *     --max-chars 8000 \
 *     --log-every 100
 *
 * ENV (optional):
 *   INGEST_API_KEY=...      # sent as Authorization: Bearer <key>
 */

import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';
import { setTimeout as sleep } from 'timers/promises';

// --------- arg parsing ----------
function argVal(args, name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const argv = process.argv.slice(2);

const FILE = argVal(argv, '--file', null);
const ENDPOINT = argVal(argv, '--endpoint', 'http://localhost:3000/v1/ingest');
const BATCH = Number(argVal(argv, '--batch', '100'));          // items per POST
const CONC = Number(argVal(argv, '--concurrency', '8'));       // parallel POSTs
const RETRIES = Number(argVal(argv, '--retries', '5'));
const TIMEOUT_MS = Number(argVal(argv, '--timeout-ms', '60000'));
const MAX_CHARS = Number(argVal(argv, '--max-chars', '8000')); // content clipping
const LOG_EVERY = Number(argVal(argv, '--log-every', '100'));  // log each N batches

if (!FILE) {
  console.error('ERROR: --file <path/to/file.jsonl> is required');
  process.exit(1);
}
const API_KEY = process.env.INGEST_API_KEY || null;

// --------- helpers ----------
function cleanContent(s) {
  if (!s) return '';
  // Remove control chars except \n and \t
  const noCtrl = s.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ' ');
  // Collapse whitespace
  let t = noCtrl.replace(/\s+/g, ' ').trim();
  // Clip to prevent oversized payloads (tune if needed)
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS);
  return t;
}

function mkIdempotencyKey(batchIndex, ids) {
  // deterministic per batch -> safe to retry same key
  const h = crypto.createHash('sha1');
  h.update(String(batchIndex));
  for (const id of ids) h.update('|').update(String(id));
  return h.digest('hex'); // use as Idempotency-Key
}

function backoff(attempt) {
  // exponential with full jitter, capped at 30s
  const base = Math.min(30000, 2 ** attempt * 500);
  return Math.floor(Math.random() * base);
}

async function postBatch(records, batchIndex) {
  const payload = { records };
  const ids = records.map(r => r.clientId || '');
  const idemKey = mkIdempotencyKey(batchIndex, ids);

  let attempt = 0;
  while (true) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

      // Prepare headers and body
      const headers = {
        'content-type': 'application/json',
        'Idempotency-Key': idemKey,
      };

      const bodyStr = JSON.stringify(payload);

      // 💥 DEBUG LOG — show everything about to be sent
      console.log(`\n=== Sending batch ${batchIndex} ===`);
      console.log('URL:', ENDPOINT);
      console.log('Headers:', JSON.stringify(headers, null, 2));
      console.log('Payload:', bodyStr.slice(0, 2000) + (bodyStr.length > 2000 ? '... [truncated]' : ''));
      console.log('===============================\n');
    
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(to);

      if (res.ok) return;

      const retryAfter = res.headers.get('retry-after');
      // Retry on 429 and 5xx
      if (res.status === 429 || res.status >= 500) {
        attempt++;
        if (attempt > RETRIES) {
          const txt = await (async () => { try { return await res.text(); } catch { return '<no-body>'; }})();
          throw new Error(`HTTP ${res.status} after ${RETRIES} retries: ${txt}`);
        }
        const raMs = retryAfter ? Number(retryAfter) * 1000 : null;
        await sleep(raMs && !Number.isNaN(raMs) ? raMs : backoff(attempt));
        continue;
      } else {
        const txt = await (async () => { try { return await res.text(); } catch { return '<no-body>'; }})();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
    } catch (err) {
      // network/timeout
      attempt++;
      if (attempt > RETRIES) throw err;
      await sleep(backoff(attempt));
    }
  }
}

// Tiny promise pool
class Pool {
  constructor(limit) { this.limit = limit; this.active = 0; this.q = []; }
  run(task) {
    return new Promise((resolve, reject) => {
      const job = async () => {
        this.active++;
        try { resolve(await task()); } catch (e) { reject(e); }
        finally { this.active--; this._drain(); }
      };
      this.q.push(job); this._drain();
    });
  }
  _drain() {
    while (this.active < this.limit && this.q.length) this.q.shift()();
  }
  async wait() { while (this.active || this.q.length) await sleep(25); }
}

// --------- main ----------
(async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const pool = new Pool(CONC);
  let cur = [];
  let batchIndex = 0;
  let sentBatches = 0, failedBatches = 0;
  let seen = 0;

  const flush = async () => {
    if (cur.length === 0) return;
    const myBatch = cur;
    const myIndex = batchIndex++;
    cur = [];

    pool.run(async () => {
      try {
        await postBatch(myBatch, myIndex);
        sentBatches++;
        if (sentBatches % LOG_EVERY === 0) {
          console.log(`Batches OK=${sentBatches} Failed=${failedBatches} (records=${sentBatches * BATCH + cur.length})`);
        }
      } catch (e) {
        failedBatches++;
        console.error(`Batch ${myIndex} failed: ${e.message}`);
        // optional: write failed batch to a sidecar file for later replay
        // fs.appendFileSync('failed_batches.jsonl', JSON.stringify({ index: myIndex, records: myBatch }) + '\n');
      }
    });
  };

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }

    const clientId = obj.id || `${obj.asin || 'noasin'}_${obj?.meta?.review_time || 'nodate'}`;
    const content = cleanContent(obj.embedding_text || obj.text || obj?.meta?.review_text || '');
    if (!content) continue; // skip empty

    cur.push({ clientId, content });
    seen++;

    if (cur.length >= BATCH) await flush();
  }

  // final flush
  await flush();
  await pool.wait();

  console.log(`Done. Lines seen=${seen}, batches ok=${sentBatches}, failed=${failedBatches}`);
})().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
