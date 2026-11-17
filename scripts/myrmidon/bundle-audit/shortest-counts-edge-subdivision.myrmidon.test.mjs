import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const moduleOf = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `${from}:${to ?? 'unknown'}:${kind}` });
const item = (path, depth, shortestPaths) => ({ path, depth, shortestPaths });
const expected = (modules) => ({ entry: 'e', modules, unreachable: ['z'] });
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 5000,
});

function check(report, oracle) {
  const input = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const fixture of [report, report, reversed]) {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(oracle)}\n`);
  }
  assert.equal(JSON.stringify(report), input);
}

const diamond = {
  entry: 'e', modules: ['e', 'a', 'b', 't'].map(path => moduleOf(path)).concat(moduleOf('z', false)),
  edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 't'), edge('b', 't'), edge('e', 'z', 'lazy'), edge('e', null)],
};
const diamondExpected = expected([item('a', 1, '1'), item('b', 1, '1'), item('e', 0, '1'), item('t', 2, '2')]);

function subdivide(report, from, to, middle) {
  return {
    ...report,
    modules: [...report.modules, moduleOf(middle)],
    edges: [...report.edges.filter(e => !(e.from === from && e.to === to && e.kind === 'eager')), edge(from, middle), edge(middle, to)],
  };
}

test('subdivision on one diamond branch removes one shortest path', () => {
  check(diamond, diamondExpected);
  check(subdivide(diamond, 'e', 'a', 'x'), expected([
    item('a', 2, '1'), item('b', 1, '1'), item('e', 0, '1'), item('t', 2, '1'), item('x', 1, '1'),
  ]));
});

test('symmetric diamond subdivision preserves both shortest paths', () => {
  check(diamond, diamondExpected);
  const transformed = subdivide(subdivide(diamond, 'e', 'a', 'x'), 'e', 'b', 'y');
  check(transformed, expected([
    item('a', 2, '1'), item('b', 2, '1'), item('e', 0, '1'), item('t', 3, '2'), item('x', 1, '1'), item('y', 1, '1'),
  ]));
});

test('subdivision of a shared suffix preserves multiplicity and increases depth', () => {
  const baseline = {
    ...diamond,
    modules: [...diamond.modules, moduleOf('u')],
    edges: [...diamond.edges, edge('t', 'u'), edge('e', 'u', 'lazy')],
  };
  check(baseline, expected([
    item('a', 1, '1'), item('b', 1, '1'), item('e', 0, '1'), item('t', 2, '2'), item('u', 3, '2'),
  ]));
  check(subdivide(baseline, 't', 'u', 'x'), expected([
    item('a', 1, '1'), item('b', 1, '1'), item('e', 0, '1'), item('t', 2, '2'), item('u', 4, '2'), item('x', 3, '2'),
  ]));
});

test('subdivided graph with a missing endpoint is rejected', () => {
  const transformed = subdivide(diamond, 'e', 'a', 'x');
  const invalid = { ...transformed, edges: [...transformed.edges, edge('x', 'missing')] };
  const result = run(invalid);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
