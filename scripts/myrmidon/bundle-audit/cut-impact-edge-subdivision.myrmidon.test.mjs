import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = (report, removed) => spawnSync(process.execPath, [cli, removed], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const expected = (removed, lostPaths, lostBytes) => ({ entry: 'e', removed, lostPaths, lostBytes });
function check(report, removed, oracle) {
  const result = run(report, removed);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(oracle)}\n`);
}
function reversed(report) {
  return { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
}

const baseModules = [moduleOf('e', 1), moduleOf('a', 3), moduleOf('t', 7), moduleOf('off', 11, false)];
const distractions = [edge('e', 'lazy-t', 'lazy', 't'), edge('e', 'unknown', 'eager', null), edge('e', 'lazy-off', 'lazy', 'off')];
const chain = { entry: 'e', modules: baseModules, edges: [edge('e', 'direct-a', 'eager', 'a'), edge('a', 'to-t', 'eager', 't'), ...distractions] };
const subdivided = (report, bytes) => ({
  ...report,
  modules: [...report.modules, moduleOf('x', bytes)],
  edges: [...report.edges.filter(item => item.specifier !== 'direct-a'), edge('e', 'to-x', 'eager', 'x'), edge('x', 'x-to-a', 'eager', 'a')],
});
const diamond = {
  ...chain,
  modules: [...chain.modules, moduleOf('b', 5)],
  edges: [...chain.edges, edge('e', 'to-b', 'eager', 'b'), edge('b', 'b-to-t', 'eager', 't')],
};

test('subdivision preserves chain closure and counts zero and positive intermediary bytes', () => {
  const cases = [
    [chain, 'a', expected('a', ['a', 't'], 10)],
    [subdivided(chain, 0), 'x', expected('x', ['a', 't', 'x'], 10)],
    [subdivided(chain, 4), 'x', expected('x', ['a', 't', 'x'], 14)],
  ];
  for (const [report, removed, oracle] of cases) {
    check(report, removed, oracle);
    check(report, removed, oracle);
    check(reversed(report), removed, oracle);
  }
});

test('subdivision in a diamond retains the shared target through the other branch', () => {
  const cases = [
    [diamond, 'a', expected('a', ['a'], 3)],
    [subdivided(diamond, 0), 'x', expected('x', ['a', 'x'], 3)],
    [subdivided(diamond, 4), 'x', expected('x', ['a', 'x'], 7)],
  ];
  for (const [report, removed, oracle] of cases) {
    check(report, removed, oracle);
    check(report, removed, oracle);
    check(reversed(report), removed, oracle);
  }
});

test('subdivision preserves a cycle downstream of the cut', () => {
  const cycle = { ...chain, edges: [...chain.edges, edge('t', 'back-to-a', 'eager', 'a')] };
  const cases = [
    [cycle, 'a', expected('a', ['a', 't'], 10)],
    [subdivided(cycle, 0), 'x', expected('x', ['a', 't', 'x'], 10)],
  ];
  for (const [report, removed, oracle] of cases) {
    check(report, removed, oracle);
    check(report, removed, oracle);
    check(reversed(report), removed, oracle);
  }
});

test('subdivided graph rejects a missing endpoint without stdout', () => {
  const graph = subdivided(chain, 0);
  const invalid = { ...graph, edges: [...graph.edges, edge('x', 'missing-endpoint', 'eager', 'missing')] };
  const result = run(invalid, 'x');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
