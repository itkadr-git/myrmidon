import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const count = 12_000;
const path = i => `module-${String(i).padStart(5, '0')}.js`;

function chain() {
  const modules = [], edges = [];
  for (let i = 0; i < count; i++) {
    modules.push({ path: path(i), bytes: i + 1, eager: i % 2 === 0 });
    if (i > 0) edges.push({ from: path(i - 1), to: path(i), kind: 'eager', specifier: path(i) });
  }
  return { entry: path(0), modules, edges };
}

function expectSinks(report, sinks, sinkBytes) {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: path(0), sinks, sinkBytes }) + '\n');
}

test('deep chain reaches its only terminal dependency', () => {
  expectSinks(chain(), [{ path: path(count - 1), bytes: count }], count);
});

test('deep cycle has no terminal dependency', () => {
  const report = chain();
  report.edges.push({ from: path(count - 1), to: path(0), kind: 'eager', specifier: path(0) });
  expectSinks(report, [], 0);
});

test('lazy shortcut does not make a disconnected terminal reachable', () => {
  const report = chain();
  report.modules.push({ path: 'disconnected.js', bytes: 999_999, eager: true });
  report.edges.push({ from: path(0), to: 'disconnected.js', kind: 'lazy', specifier: 'disconnected.js' });
  expectSinks(report, [{ path: path(count - 1), bytes: count }], count);
});
