#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHooks, classify } from './hooks.mjs';
import { BASELINE, estimateTokens, generateBaselineSessionStart, generateBaselineMemoryRead } from './token-benchmark.mjs';

const BASELINE_VERSION = 'ope-9247-baseline-v1 (24,200B SessionStart; 800B injection + 800B memory read per prompt)';
const CURRENT_VERSION = 'main-d92db61c5/scripts/myrmidon/adm-connector';

function parseDataset(argv) {
  const i = argv.indexOf('--dataset');
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const bytes = text => Buffer.byteLength(text, 'utf8');
const estimate = text => estimateTokens(text);

async function main() {
  const datasetPath = parseDataset(process.argv.slice(2));
  if (!datasetPath) throw new Error('usage: offline-token-harness.mjs --dataset <json-array>');
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  if (!Array.isArray(dataset) || dataset.length !== 50 || dataset.some(row => !row || typeof row.text !== 'string')) {
    throw new Error('dataset must be a JSON array of exactly 50 {text} objects');
  }
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adm-offline-bench-'));
  try {
    const sessionId = 'offline-token-benchmark';
    // The operator-owned dataset is local input only. Hook metadata is a pinned
    // offline snapshot; never fetch REST data while measuring it.
    const loader = async () => ({ items: (await import('./failure-matrix.mjs')).STANDARD_ITEMS, fetchedAt: Date.now(), degraded: false });
    const hooks = createHooks({ stateDir, load: loader });
    const oldStart = generateBaselineSessionStart();
    const newStartResult = await hooks.run({ hook_event_name: 'SessionStart', session_id: sessionId });
    const newStart = newStartResult.context;
    const records = [];
    let oldBytes = bytes(oldStart), oldTokens = estimate(oldStart);
    let newBytes = bytes(newStart), newTokens = estimate(newStart);
    for (let i = 0; i < dataset.length; i += 1) {
      const prompt = dataset[i].text;
      const matched = classify(prompt).length > 0;
      const oldRead = matched ? generateBaselineMemoryRead('matched-trigger') : '';
      const oldMemoryOverhead = matched ? BASELINE.hookPerMessageBytes : 0;
      const oldInjection = matched ? 'UserPromptSubmit standard baseline context injection\n'.repeat(12) : '';
      const current = await hooks.run({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt });
      const ob = oldMemoryOverhead + bytes(oldRead) + bytes(oldInjection);
      const ot = estimate(oldRead) + estimate(oldInjection);
      const nb = current.bytes;
      const nt = estimate(current.context);
      oldBytes += ob; oldTokens += ot; newBytes += nb; newTokens += nt;
      records.push({ index: i + 1, oldBytes: ob, oldTokens: ot, newBytes: nb, newTokens: nt });
    }
    const totals = {
      oldBytes, oldTokens, newBytes, newTokens,
      byteSavings: oldBytes - newBytes,
      tokenSavings: oldTokens - newTokens,
      newBytesNotGreater: newBytes <= oldBytes,
      newTokensNotGreater: newTokens <= oldTokens,
      sessionStartWithin12KiB: bytes(newStart) <= 12 * 1024,
      everyPromptWithin2KiB: records.every(r => r.newBytes <= 2 * 1024),
      unmatchedZeroInjection: records.every((r, i) => classify(dataset[i].text).length > 0 || r.newBytes === 0),
    };
    process.stdout.write(JSON.stringify({
      baselineVersion: BASELINE_VERSION,
      currentVersion: CURRENT_VERSION,
      tokenizer: 'deterministic_bpe_v1 estimate (offline; no model/API calls)',
      count: records.length,
      oldSessionStart: { bytes: bytes(oldStart), tokens: estimate(oldStart) },
      newSessionStart: { bytes: bytes(newStart), tokens: estimate(newStart) },
      messages: records,
      totals,
    }) + '\n');
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
main().catch(() => { process.stderr.write('offline benchmark failed; no dataset contents emitted\n'); process.exitCode = 1; });
