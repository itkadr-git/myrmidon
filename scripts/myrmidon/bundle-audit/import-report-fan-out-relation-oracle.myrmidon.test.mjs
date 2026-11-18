import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const paths = ['A', 'b', 'c', 'isolated'];
const bytes = [11, 22, 33, 44];

function fixture(mask, selfLoop = false) {
  const matrix = Array.from({ length: 4 }, () => Array(4).fill(false));
  let bit = 0;
  for (let from = 0; from < 3; from++) {
    for (let to = 0; to < 3; to++) {
      if (from !== to) matrix[from][to] = Boolean(mask & (1 << bit++));
    }
  }
  if (selfLoop) matrix[1][1] = true;
  const edges = [];
  for (let from = 0; from < 3; from++) {
    for (let to = 0; to < 3; to++) {
      if (matrix[from][to]) {
        edges.push({ from: paths[from], specifier: `edge-${to}`, kind: 'eager', to: paths[to] });
        edges.push({ from: paths[from], specifier: `alias-${to}`, kind: 'eager', to: paths[to] });
      }
    }
    edges.push({ from: paths[from], specifier: 'lazy-only', kind: 'lazy', to: paths[3] });
    edges.push({ from: paths[from], specifier: 'missing', kind: 'eager', to: null });
    edges.push({ from: paths[from], specifier: 'missing-lazy', kind: 'lazy', to: null });
  }
  const modules = paths.map((path, i) => ({ path, bytes: bytes[i], eager: Boolean((mask >> i) & 1) }));
  const rows = paths.map((path, from) => {
    const targets = [];
    for (let to = 0; to < paths.length; to++) if (matrix[from][to]) targets.push(paths[to]);
    return { path, bytes: bytes[from], targets, fanOut: targets.length };
  });
  // Enumerate rank buckets and lexically ordered paths without the production sort pipeline.
  const ordered = [];
  for (let count = 4; count >= 0; count--) {
    for (const row of rows) if (row.fanOut === count) ordered.push(row);
  }
  return { report: { entry: 'A', modules: modules.reverse(), edges: edges.reverse() }, expected: { entry: 'A', modules: ordered } };
}

function check(t, report, expected, label) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'fan-out-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: dir,
    env: { ...process.env, HOME: dir, TMPDIR: dir }, shell: false,
    timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, label);
  assert.equal(result.signal, null, label);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, label);
}

test('all 64 direct eager relations match the adjacency matrix', t => {
  for (let mask = 0; mask < 64; mask++) {
    const { report, expected } = fixture(mask);
    check(t, report, expected, `graph ${mask}`);
  }
});

test('a self-loop is one direct target even with aliases', t => {
  const { report, expected } = fixture(0, true);
  check(t, report, expected, 'self loop');
});
