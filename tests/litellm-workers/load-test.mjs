#!/usr/bin/env node
// Paced parallel HTTP load generator with per-request latency capture and
// 5xx/timeout/drop accounting. Part C rig for OPE-5391 (LITELLM-WORKERS).
//
// Targets the LiteLLM gateway itself (chat completions through the proxy), so
// the measured latency is the answer time the operators see, not a health ping.
//
// Usage:
//   node load-test.mjs --url URL [--model M] [--prompt P] [--duration 60]
//                      [--concurrency 6] [--timeout-ms 120000] [--tag phase]
// With --model the requests are JSON POSTs to /v1/chat/completions; without it
// they are GETs to --url (any endpoint that answers). The gateway key is read
// from $LITELLM_KEY (never printed).
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url', 'http://127.0.0.1:4000/v1/chat/completions');
const model = arg('model', '');           // e.g. openai/gpt-4o-mini
const prompt = arg('prompt', 'Reply with the single word: pong');
const durationS = Number(arg('duration', '60'));
const concurrency = Number(arg('concurrency', '6'));
const timeoutMs = Number(arg('timeout-ms', '120000'));
const tag = arg('tag', 'load');
const key = process.env.LITELLM_KEY || '';

const post = Boolean(model);
const headers = { 'content-type': 'application/json' };
if (key) headers.authorization = `Bearer ${key}`;
const body = post
  ? JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 8 })
  : undefined;

const samples = [];
let failures = 0;

function record(ok, ms, status, err) {
  samples.push({ ok, ms, status });
  if (!ok) {
    failures += 1;
    console.error(JSON.stringify({ tag, event: 'failure', ms, status, err: err || null }));
  }
}

async function one() {
  const started = performance.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: post ? 'POST' : 'GET', headers, body, signal: ac.signal });
      // Drain the body so the request is fully accounted before timing stops.
      await res.arrayBuffer();
      record(res.status >= 200 && res.status < 500, performance.now() - started, res.status);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    record(false, performance.now() - started, null, e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message));
  }
}

async function worker() {
  while (!stop) {
    await one();
    // Small pacing gap so concurrency N means N in-flight, not a tight loop.
    await sleep(50);
  }
}

let stop = false;
const t0 = performance.now();
const workers = Array.from({ length: concurrency }, () => worker());
setTimeout(() => { stop = true; }, durationS * 1000);
await Promise.all(workers);
const wall = (performance.now() - t0) / 1000;

const lat = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
const pick = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
const summary = {
  tag,
  url: url.replace(/(Bearer )[^\s]+/g, '$1<redacted>'),
  model: model || null,
  requests: samples.length,
  failures,
  failureRate: samples.length ? failures / samples.length : 0,
  medianMs: pick(0.5),
  p95Ms: pick(0.95),
  wallS: Number(wall.toFixed(2)),
};
console.log(JSON.stringify({ event: 'summary', ...summary }));
process.exitCode = failures > 0 ? 1 : 0;
