import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-layers.mjs', import.meta.url).pathname;
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });

function check(report, expected) {
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
}

function pair(baseline, shortcut, expectedBefore, expectedAfter, transformedModules = baseline.modules) {
  const transformed = { ...baseline, modules: transformedModules, edges: [...baseline.edges, shortcut] };
  check(baseline, expectedBefore);
  check(transformed, expectedAfter);
  check({ ...transformed, modules: baseline.modules, edges: transformed.edges.slice(0, -1) }, expectedBefore);
}

test('eager and lazy shortcuts preserve the complete linear graph contract', () => {
  const report = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3), moduleOf('c', 4), moduleOf('z', 9, false)], edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'c')] };
  const before = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }, { depth: 2, paths: ['b'], bytes: 3 }, { depth: 3, paths: ['c'], bytes: 4 }], unreachable: ['z'] };
  const after = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'c'], bytes: 6 }, { depth: 2, paths: ['b'], bytes: 3 }], unreachable: ['z'] };
  pair(report, edge('e', 'c', 'eager', 'shortcut-eager'), before, after);
  pair(report, edge('e', 'c', 'lazy', 'shortcut-lazy'), before, before);
});

test('eager shortcut reduces downstream depth as well', () => {
  const report = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3), moduleOf('c', 4), moduleOf('d', 5)], edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd')] };
  const before = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }, { depth: 2, paths: ['b'], bytes: 3 }, { depth: 3, paths: ['c'], bytes: 4 }, { depth: 4, paths: ['d'], bytes: 5 }], unreachable: [] };
  const after = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'c'], bytes: 6 }, { depth: 2, paths: ['b', 'd'], bytes: 8 }], unreachable: [] };
  pair(report, edge('e', 'c', 'eager', 'shortcut'), before, after);
});

test('eager entry into a lazy-only island adds all reachable paths', () => {
  const report = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('x', 4, false), moduleOf('y', 8, false), moduleOf('z', 16, false)], edges: [edge('e', 'a'), edge('e', 'x', 'lazy'), edge('x', 'y')] };
  const before = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }], unreachable: ['x', 'y', 'z'] };
  const after = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'x'], bytes: 6 }, { depth: 2, paths: ['y'], bytes: 8 }], unreachable: ['z'] };
  const modules = [moduleOf('e', 1), moduleOf('a', 2), moduleOf('x', 4), moduleOf('y', 8), moduleOf('z', 16, false)];
  pair(report, edge('e', 'x', 'eager', 'island-entry'), before, after, modules);
});

test('missing endpoint fails as graph without exposing input', () => {
  const result = run({ entry: 'secret-entry', modules: [moduleOf('secret-entry', 1)], edges: [edge('secret-entry', 'secret-missing')] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
