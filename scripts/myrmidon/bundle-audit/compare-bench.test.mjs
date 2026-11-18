import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'compare-bench.mjs');
const fixture = (warm) => ({ cmd: 'node server', envKeys: ['A', 'B'], runs: [100, ...warm].map((seconds, i) => ({ run: i + 1, seconds, cold: i === 0 })), summary: { medianSeconds: 99999 } });
function run(a, b, args = []) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'bench-'));
  try {
    const files = [join(dir, 'a.json'), join(dir, 'b.json')];
    [a, b].forEach((value, i) => writeFileSync(files[i], typeof value === 'string' ? value : JSON.stringify(value)));
    return spawnSync(process.execPath, [script, ...files, ...args], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('ratio boundary, cold separation, untrusted summary and reproducible report', () => {
  const a = fixture([20, 30, 40]); const b = fixture([10, 15, 20]);
  const first = run(a, b); const second = run(a, b);
  assert.equal(first.status, 0); assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.verdict, 'PASS'); assert.equal(report.ratio, 2);
  assert.deepEqual(report.baseline.warm, { count: 3, min: 20, median: 30, max: 40 });
  assert.equal(report.baseline.cold.seconds, 100);
});

test('ratio below threshold fails with exit code 1', () => {
  const result = run(fixture([19.9, 19.9, 19.9]), fixture([10, 10, 10]));
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).verdict, 'FAIL');
  assert.ok(Math.abs(JSON.parse(result.stdout).ratio - 1.99) < 1e-12);
});

test('rejects invalid samples and malformed JSON with exit code 2', () => {
  for (const bad of [0, -1, null, 'NaN']) {
    const result = run(fixture([1, bad, 2]), fixture([1, 1, 1]));
    assert.equal(result.status, 2); assert.match(result.stderr, /seconds/);
  }
  assert.equal(run('{"runs":[NaN]}', fixture([1, 1, 1])).status, 2);
  assert.equal(run(fixture([1, 2]), fixture([1, 1, 1])).status, 2);
  const broken = fixture([1, 2, 3]); broken.runs[1].cold = true;
  assert.equal(run(broken, fixture([1, 1, 1])).status, 2);
});

test('conditions require explicit nonblank override reason', () => {
  const a = fixture([2, 2, 2]); const b = fixture([1, 1, 1]); b.cmd = 'other'; b.envKeys = ['C'];
  assert.equal(run(a, b).status, 2);
  assert.equal(run(a, b, ['--override-reason', ' ']).status, 2);
  const result = run(a, b, ['--override-reason', 'synthetic comparison']);
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).overrideReason, 'synthetic comparison');
  delete b.cmd; assert.equal(run(a, b, ['--override-reason', 'test']).status, 2);
  b.cmd = 'node server'; b.envKeys = ['B', 'A']; assert.equal(run(a, b).status, 0);
});
