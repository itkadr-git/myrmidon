import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const fixtures = [
  { name: 'chain', nodes: [['a', 2], ['b', 3], ['c', 7]], links: [['a', 'b'], ['b', 'c']] },
  { name: 'diamond shared suffix', nodes: [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 11]], links: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e']] },
  { name: 'cycle with exit', nodes: [['a', 1], ['b', 2], ['c', 3], ['d', 13]], links: [['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd']] },
  { name: 'mixed and self-loop', nodes: [['a', 1], ['b', 5], ['c', 7], ['d', 11], ['z', 19]], links: [['a', 'b'], ['a', 'c'], ['b', 'b'], ['c', 'd', 'lazy'], ['a', null], ['z', 'd']] },
];

// Derive reachability from the original relation, before alias expansion.
function reachable(fixture) {
  const reached = new Set(['a']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to, kind = 'eager'] of fixture.links) {
      if (kind === 'eager' && to !== null && reached.has(from) && !reached.has(to)) {
        reached.add(to);
        changed = true;
      }
    }
  }
  return reached;
}

function expected(fixture) {
  const reached = reachable(fixture);
  const sinks = fixture.nodes
    .filter(([path]) => reached.has(path) && !fixture.links.some(([from, to, kind = 'eager']) => from === path && kind === 'eager' && to !== null))
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entry: 'a', sinks, sinkBytes: sinks.reduce((sum, node) => sum + node.bytes, 0) };
}

function makeReport(fixture, count, reverse = false) {
  const reached = reachable(fixture);
  const modules = fixture.nodes.map(([path, bytes]) => ({ path, bytes, eager: reached.has(path) }));
  const edges = fixture.links.flatMap(([from, to, kind = 'eager'], index) =>
    Array.from({ length: to === null ? 1 : count }, (_, alias) => ({ from, to, kind, specifier: `edge-${index}-alias-${alias}` })));
  return { entry: 'a', modules: reverse ? modules.reverse() : modules, edges: reverse ? edges.reverse() : edges };
}

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
}

function assertOutput(result, oracle) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(oracle) + '\n');
}

for (const fixture of fixtures) {
  test(`${fixture.name}: aliases and input order preserve exact sinks`, () => {
    const oracle = expected(fixture);
    for (const count of [1, 2, 4]) {
      for (const reverse of [false, true]) {
        assertOutput(run(makeReport(fixture, count, reverse)), oracle);
      }
    }
  });
}

test('oracle has meaningful nonempty output and catches a corrupted result', () => {
  const fixture = fixtures[1];
  const oracle = expected(fixture);
  assert.deepEqual(oracle, { entry: 'a', sinks: [{ path: 'e', bytes: 11 }], sinkBytes: 11 });
  const result = run(makeReport(fixture, 4));
  assertOutput(result, oracle);
  assert.throws(() => assertOutput(result, { ...oracle, sinkBytes: oracle.sinkBytes + 1 }), assert.AssertionError);
});

test('duplicate complete import tuple is rejected, unlike distinct aliases', () => {
  const report = makeReport(fixtures[0], 4);
  assertOutput(run(report), expected(fixtures[0]));
  report.edges.push({ ...report.edges[0] });
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.notEqual(result.stderr.trim(), '');
});
