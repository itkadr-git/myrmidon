import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const mod = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, specifier, to) => ({ from, specifier, to, kind: 'eager' });

const cases = [
  {
    name: 'zero-byte wrapper preserves saved bytes and adds one removed module',
    baseline: { entry: 'entry', modules: [mod('entry', 10), mod('u', 3), mod('v', 20), mod('leaf', 5)], edges: [edge('entry', './u', 'u'), edge('u', './v', 'v'), edge('v', './leaf', 'leaf')] },
    transformed: { entry: 'entry', modules: [mod('entry', 10), mod('u', 3), mod('v', 20), mod('leaf', 5), mod('x', 0)], edges: [edge('entry', './u', 'u'), edge('u', './x', 'x'), edge('x', './v', 'v'), edge('v', './leaf', 'leaf')] },
    baselineExpected: { entry: 'entry', selected: { from: 'u', specifier: './v', to: 'v' }, before: { modules: 4, bytes: 38 }, after: { modules: 2, bytes: 13 }, removedPaths: ['leaf', 'v'], savedBytes: 25 },
    transformedExpected: { entry: 'entry', selected: { from: 'u', specifier: './x', to: 'x' }, before: { modules: 5, bytes: 38 }, after: { modules: 2, bytes: 13 }, removedPaths: ['leaf', 'v', 'x'], savedBytes: 25 },
  },
  {
    name: 'seven-byte wrapper adds its bytes to the saving',
    baseline: { entry: 'entry', modules: [mod('entry', 11), mod('u', 2), mod('v', 23)], edges: [edge('entry', './u', 'u'), edge('u', './v', 'v')] },
    transformed: { entry: 'entry', modules: [mod('entry', 11), mod('u', 2), mod('v', 23), mod('x', 7)], edges: [edge('entry', './u', 'u'), edge('u', './x', 'x'), edge('x', './v', 'v')] },
    baselineExpected: { entry: 'entry', selected: { from: 'u', specifier: './v', to: 'v' }, before: { modules: 3, bytes: 36 }, after: { modules: 2, bytes: 13 }, removedPaths: ['v'], savedBytes: 23 },
    transformedExpected: { entry: 'entry', selected: { from: 'u', specifier: './x', to: 'x' }, before: { modules: 4, bytes: 43 }, after: { modules: 2, bytes: 13 }, removedPaths: ['v', 'x'], savedBytes: 30 },
  },
  {
    name: 'alternate eager route retains v and only wrapper is removed',
    baseline: { entry: 'entry', modules: [mod('entry', 10), mod('u', 3), mod('v', 20), mod('other', 4)], edges: [edge('entry', './u', 'u'), edge('u', './v', 'v'), edge('entry', './other', 'other'), edge('other', './v-alt', 'v')] },
    transformed: { entry: 'entry', modules: [mod('entry', 10), mod('u', 3), mod('v', 20), mod('other', 4), mod('x', 7)], edges: [edge('entry', './u', 'u'), edge('u', './x', 'x'), edge('x', './v', 'v'), edge('entry', './other', 'other'), edge('other', './v-alt', 'v')] },
    baselineExpected: { entry: 'entry', selected: { from: 'u', specifier: './v', to: 'v' }, before: { modules: 4, bytes: 37 }, after: { modules: 4, bytes: 37 }, removedPaths: [], savedBytes: 0 },
    transformedExpected: { entry: 'entry', selected: { from: 'u', specifier: './x', to: 'x' }, before: { modules: 5, bytes: 44 }, after: { modules: 4, bytes: 37 }, removedPaths: ['x'], savedBytes: 7 },
  },
];

function run(dir, report, specifier) {
  const file = join(dir, 'report.json');
  const text = JSON.stringify(report);
  writeFileSync(file, text);
  const result = spawnSync(process.execPath, [cli, file, 'u', specifier], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(JSON.stringify(report), text);
  return result;
}

function check(dir, report, specifier, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = run(dir, input, specifier);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  assert.equal(JSON.stringify(report), original);
}

for (const scenario of cases) {
  test(scenario.name, () => {
    const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'edge-subdivision-'));
    try {
      check(dir, scenario.baseline, './v', scenario.baselineExpected);
      check(dir, scenario.transformed, './x', scenario.transformedExpected);
      assert.equal(scenario.transformedExpected.removedPaths.length, scenario.baselineExpected.removedPaths.length + 1);
      assert.equal(scenario.transformedExpected.before.modules - scenario.transformedExpected.after.modules, scenario.baselineExpected.before.modules - scenario.baselineExpected.after.modules + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('missing wrapper endpoint is rejected', () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'edge-subdivision-invalid-'));
  try {
    const report = { entry: 'entry', modules: [mod('entry', 1), mod('u', 2), mod('v', 3)], edges: [edge('entry', './u', 'u'), edge('u', './x', 'x'), edge('x', './v', 'v')] };
    const result = run(dir, report, './x');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'error: graph\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
