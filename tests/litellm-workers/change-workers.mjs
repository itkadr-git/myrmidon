#!/usr/bin/env node
// Changes the LiteLLM worker count through the same REST contract the
// Gateway Workers UI tab uses, then polls GET until the applied pool size
// matches the target. Part C rig for OPE-5391 (LITELLM-WORKERS).
//
// Usage: node change-workers.mjs --base URL --company ID --to 4
//   --base     board/API origin, e.g. http://127.0.0.1:3100
//   --company  company whose LiteLLM workers to drive
//   --to       target worker count
// The board API key is read from $BOARD_API_KEY (never printed).
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', 'http://127.0.0.1:3100').replace(/\/+$/, '');
const company = arg('company', process.env.STAND_COMPANY_ID || '');
const to = Number(arg('to', '4'));
const key = process.env.BOARD_API_KEY;
if (!company) { console.error('missing --company / STAND_COMPANY_ID'); process.exit(2); }
if (!key) { console.error('missing API key in $BOARD_API_KEY'); process.exit(2); }

const path = `/api/myrmidon/companies/${company}/litellm/workers`;
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function get() {
  const res = await fetch(base + path, { headers });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return res.json();
}

const before = await get();
const from = before.current ?? before.target ?? null;
const t0 = performance.now();
const res = await fetch(base + path, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ target: to }),
});
if (!res.ok) {
  console.error(JSON.stringify({ event: 'put-failed', status: res.status, body: await res.text() }));
  process.exit(1);
}
const applied = await res.json();

// Poll the view until the live pool size reaches the target. `current` comes
// from the gateway metrics when available and falls back to the last applied
// value; either way it equals the target once the resize has settled.
let current = applied.current ?? null;
const deadline = performance.now() + 120000;
while (current !== to && performance.now() < deadline) {
  await sleep(1000);
  current = (await get()).current ?? null;
}
const settleMs = Math.round(performance.now() - t0);
console.log(JSON.stringify({ event: 'changed', from, to, settleMs, current }));
process.exitCode = current === to ? 0 : 1;
