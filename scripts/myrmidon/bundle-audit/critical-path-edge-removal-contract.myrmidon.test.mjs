import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier = String(to), kind = 'eager') => ({ from, to, specifier, kind });
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});

function expectOutput(report, expected) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
}

function without(report, removed, eagerPaths) {
  assert.equal(report.edges.filter(item => item === removed).length, 1);
  const result = {
    ...report,
    modules: report.modules.map(item => ({ ...item, eager: eagerPaths.includes(item.path) })),
    edges: report.edges.filter(item => item !== removed).map(item => ({ ...item })),
  };
  assert.deepEqual(result.modules.map(({ path, bytes }) => ({ path, bytes })), report.modules.map(({ path, bytes }) => ({ path, bytes })));
  return result;
}

test('chain removal preserves the source module and restoring the edge restores the path', () => {
  const removed = edge('a', 'b');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 4)], edges: [edge('e', 'a'), removed] };
  const original = structuredClone(before);
  const after = without(before, removed, ['e', 'a']);
  assert.equal(after.modules[2].eager, false);
  const full = { entry: 'e', paths: ['e', 'a', 'b'], bytes: 7 };
  expectOutput(before, full);
  expectOutput(after, { entry: 'e', paths: ['e', 'a'], bytes: 3 });
  const restored = { ...after, modules: after.modules.map(item => ({ ...item, eager: true })), edges: [...after.edges, { ...removed }] };
  expectOutput(restored, full);
  assert.deepEqual(before, original);
});

test('weighted diamond falls back to the remaining branch after edge removal', () => {
  const removed = edge('a', 't');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 5), moduleOf('b', 2), moduleOf('t', 4)], edges: [edge('e', 'a'), edge('e', 'b'), removed, edge('b', 't')] };
  const original = structuredClone(before);
  const after = without(before, removed, ['e', 'a', 'b', 't']);
  expectOutput(before, { entry: 'e', paths: ['e', 'a', 't'], bytes: 10 });
  expectOutput(after, { entry: 'e', paths: ['e', 'b', 't'], bytes: 7 });
  assert.deepEqual(before, original);
});

test('equal-weight diamond uses lexical tie break and retains the alternate path', () => {
  const removed = edge('a', 't');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 2), moduleOf('t', 4)], edges: [edge('e', 'b'), edge('b', 't'), edge('e', 'a'), removed] };
  const original = structuredClone(before);
  const after = without(before, removed, ['e', 'a', 'b', 't']);
  expectOutput(before, { entry: 'e', paths: ['e', 'a', 't'], bytes: 7 });
  expectOutput(after, { entry: 'e', paths: ['e', 'b', 't'], bytes: 7 });
  assert.deepEqual(before, original);
});

test('removing lazy, unknown, or one eager alias leaves the path unchanged', () => {
  const lazy = edge('e', 'x', 'lazy-x', 'lazy');
  const unknown = edge('e', null, 'unresolved');
  const alias = edge('e', 'a', 'alias-a');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('x', 9, false)], edges: [edge('e', 'a', 'primary-a'), alias, lazy, unknown] };
  const original = structuredClone(before);
  const expected = { entry: 'e', paths: ['e', 'a'], bytes: 3 };
  expectOutput(before, expected);
  for (const removed of [lazy, unknown, alias]) expectOutput(without(before, removed, ['e', 'a']), expected);
  assert.deepEqual(before, original);
});

test('missing edge endpoint is rejected without exposing paths', () => {
  const report = { entry: 'private-entry', modules: [moduleOf('private-entry', 1)], edges: [edge('private-entry', 'private-missing')] };
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.doesNotMatch(result.stderr, /private-entry|private-missing/);
});
