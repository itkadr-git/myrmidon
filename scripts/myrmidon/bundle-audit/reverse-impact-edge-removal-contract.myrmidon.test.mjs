import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, specifier, kind });
const modules = (eager, lazy = []) => [
  ...eager.map(path => ({ path, bytes: 1, eager: true })),
  ...lazy.map(path => ({ path, bytes: 1, eager: false })),
];
const result = importers => ({ entry: 'e', target: 't', importers });
const importer = (path, distance) => ({ path, distance });

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const value of [report, report, reversed]) {
    const run = spawnSync(process.execPath, [cli, '-', 't'], {
      input: JSON.stringify(value), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, `${JSON.stringify(expected)}\n`);
  }
  assert.equal(JSON.stringify(report), original);
}

function contract(before, removedIndex, afterModules, beforeExpected, afterExpected) {
  const original = JSON.stringify(before);
  const after = {
    ...before,
    modules: afterModules,
    edges: before.edges.filter((_, i) => i !== removedIndex),
  };
  check(before, beforeExpected);
  check(after, afterExpected);
  assert.equal(JSON.stringify(before), original);
  const restored = { ...after, modules: before.modules.map(mod => ({ ...mod })), edges: [...after.edges] };
  restored.edges.splice(removedIndex, 0, { ...before.edges[removedIndex] });
  assert.deepEqual(restored, before);
  check(restored, beforeExpected);
}

test('removing a shortcut recalculates the shortest distance', () => {
  const before = { entry: 'e', modules: modules(['e', 'a', 'b', 't']), edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 't'), edge('e', 't')] };
  contract(before, 3, modules(['e', 'a', 'b', 't']),
    result([importer('b', 1), importer('e', 1), importer('a', 2)]),
    result([importer('b', 1), importer('a', 2), importer('e', 3)]));
});

test('removing a diamond edge retains the alternative path', () => {
  const before = { entry: 'e', modules: modules(['e', 'a', 'b', 'c', 't']), edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 't'), edge('b', 'c'), edge('c', 't'), edge('a', 'b')] };
  contract(before, 2, modules(['e', 'a', 'b', 'c', 't']),
    result([importer('a', 1), importer('c', 1), importer('b', 2), importer('e', 2)]),
    result([importer('c', 1), importer('b', 2), importer('a', 3), importer('e', 3)]));
});

test('removing the only route keeps unreachable modules and target known', () => {
  const before = { entry: 'e', modules: modules(['e', 'a', 't']), edges: [edge('e', 'a'), edge('a', 't')] };
  contract(before, 1, modules(['e', 'a'], ['t']),
    result([importer('a', 1), importer('e', 2)]), result([]));
});

test('removing lazy, unknown, or one alias edge does not change impact', () => {
  const before = { entry: 'e', modules: modules(['e', 'a', 't']), edges: [edge('e', 'a'), edge('a', 't'), edge('a', 't', 'eager', 'alias'), edge('e', 't', 'lazy'), edge('e', null)] };
  const expected = result([importer('a', 1), importer('e', 2)]);
  for (const index of [2, 3, 4]) contract(before, index, modules(['e', 'a', 't']), expected, expected);
});

test('missing endpoint fails closed without exposing input paths', () => {
  const report = { entry: 'e', modules: modules(['e'], ['t']), edges: [edge('e', 'private-missing-path')] };
  const run = spawnSync(process.execPath, [cli, '-', 't'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'graph\n');
});
