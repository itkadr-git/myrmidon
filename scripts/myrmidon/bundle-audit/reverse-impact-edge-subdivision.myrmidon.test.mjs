import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const mod = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `${from}->${to}` });

function check(report, expected) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'subdivision-'));
  try {
    const file = join(dir, 'report.json');
    const original = JSON.stringify(report);
    const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
    for (const input of [report, report, reversed]) {
      const serialized = JSON.stringify(input);
      writeFileSync(file, serialized);
      const result = spawnSync(process.execPath, [cli, file, 'v'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
      assert.equal(readFileSync(file, 'utf8'), serialized);
      assert.equal(JSON.stringify(report), original);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('subdividing a chain increases distances for u and its ancestors', () => {
  const baseline = { entry: 'e', modules: ['e', 'p', 'u', 'v'].map(p => mod(p)), edges: [edge('e', 'p'), edge('p', 'u'), edge('u', 'v')] };
  const transformed = { entry: 'e', modules: ['e', 'p', 'u', 'x', 'v'].map(p => mod(p)), edges: [edge('e', 'p'), edge('p', 'u'), edge('u', 'x'), edge('x', 'v')] };
  check(baseline, { entry: 'e', target: 'v', importers: [{ path: 'u', distance: 1 }, { path: 'p', distance: 2 }, { path: 'e', distance: 3 }] });
  check(transformed, { entry: 'e', target: 'v', importers: [{ path: 'x', distance: 1 }, { path: 'u', distance: 2 }, { path: 'p', distance: 3 }, { path: 'e', distance: 4 }] });
});

test('subdividing one diamond branch preserves the direct shortcut', () => {
  const baseline = { entry: 'e', modules: ['e', 'u', 'a', 'v'].map(p => mod(p)), edges: [edge('e', 'u'), edge('u', 'a'), edge('a', 'v'), edge('u', 'v')] };
  const transformed = { entry: 'e', modules: ['e', 'u', 'a', 'x', 'v'].map(p => mod(p)), edges: [edge('e', 'u'), edge('u', 'a'), edge('a', 'x'), edge('x', 'v'), edge('u', 'v')] };
  check(baseline, { entry: 'e', target: 'v', importers: [{ path: 'a', distance: 1 }, { path: 'u', distance: 1 }, { path: 'e', distance: 2 }] });
  check(transformed, { entry: 'e', target: 'v', importers: [{ path: 'u', distance: 1 }, { path: 'x', distance: 1 }, { path: 'a', distance: 2 }, { path: 'e', distance: 2 }] });
});

test('a lazy first segment cuts the eager path but x remains an importer', () => {
  const baseline = { entry: 'e', modules: ['e', 'u', 'v'].map(p => mod(p)), edges: [edge('e', 'u'), edge('u', 'v')] };
  const transformed = { entry: 'e', modules: [mod('e'), mod('u'), mod('x', false), mod('v', false)], edges: [edge('e', 'u'), edge('u', 'x', 'lazy'), edge('x', 'v')] };
  check(baseline, { entry: 'e', target: 'v', importers: [{ path: 'u', distance: 1 }, { path: 'e', distance: 2 }] });
  check(transformed, { entry: 'e', target: 'v', importers: [{ path: 'x', distance: 1 }] });
});

test('a subdivision with a missing intermediate endpoint fails closed', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'subdivision-invalid-'));
  try {
    const file = join(dir, 'report.json');
    const report = { entry: 'e', modules: [mod('e'), mod('u'), mod('v')], edges: [edge('e', 'u'), edge('u', 'x'), edge('x', 'v')] };
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file, 'v'], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
