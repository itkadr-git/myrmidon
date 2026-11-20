import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const graphs = [
  { name: 'chain', nodes: ['e', 'a', 'b', 't'], edges: [['e', 'a'], ['a', 'b'], ['b', 't']] },
  { name: 'diamond', nodes: ['e', 'a', 'b', 't'], edges: [['e', 'a'], ['e', 'b'], ['a', 't'], ['b', 't']] },
  { name: 'lazy and disconnected', nodes: ['e', 'a', 't', 'x', 'y'], edges: [['e', 'a'], ['a', 't'], ['e', 't', 'lazy'], ['e', 'x', 'lazy'], ['x', 'y'], ['y', 'x']] },
  { name: 'mixed eager and lazy', nodes: ['e', 'a', 'b', 'c', 't', 'x'], edges: [['e', 'a'], ['a', 'b'], ['b', 't'], ['e', 'c'], ['c', 't'], ['e', 't', 'lazy'], ['a', 'c', 'lazy'], ['x', 't'], ['t', 'a']] },
];

// Enumerate simple paths from each candidate; do not derive expectations from CLI output.
function distance(graph, start, target, visited = new Set()) {
  if (start === target) return 0;
  const seen = new Set([...visited, start]);
  const lengths = graph.edges
    .filter(([from, to, kind = 'eager']) => from === start && kind === 'eager' && !seen.has(to))
    .map(([, to]) => distance(graph, to, target, seen))
    .filter(value => value !== Infinity);
  return lengths.length ? 1 + Math.min(...lengths) : Infinity;
}

function expected(graph, target) {
  const importers = graph.nodes.filter(path => path !== target)
    .map(path => ({ path, distance: distance(graph, path, target) }))
    .filter(item => item.distance !== Infinity)
    .sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entry: 'e', target, importers };
}

function reportFor(graph, count) {
  return {
    entry: 'e',
    modules: graph.nodes.map((path, index) => ({ path, bytes: 11 + index, eager: distance(graph, 'e', path) !== Infinity })),
    edges: graph.edges.flatMap(([from, to, kind = 'eager'], index) =>
      Array.from({ length: count }, (_, n) => ({ from, to, kind, specifier: `specifier-${index}-${n}` }))),
  };
}

function run(report, target) {
  return spawnSync(process.execPath, [cli, '-', target], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
}

function assertResult(result, oracle) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), oracle);
}

for (const graph of graphs) {
  test(`${graph.name}: parallel specifiers preserve all reachable targets`, () => {
    for (const count of [1, 2, 4]) {
      const report = reportFor(graph, count);
      assert.equal(new Set(report.edges.map(edge => JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]))).size, report.edges.length);
      for (const target of graph.nodes.filter(path => distance(graph, 'e', path) !== Infinity)) {
        const oracle = expected(graph, target);
        for (const value of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
          assertResult(run(value, target), oracle);
        }
      }
    }
  });
}

test('oracle rejects missing or duplicated importers and constant output', () => {
  const oracle = expected(graphs[0], 't');
  const fake = value => ({ status: 0, stderr: '', stdout: JSON.stringify(value) });
  assert.ok(oracle.importers.length > 0);
  assert.throws(() => assertResult(fake({ ...oracle, importers: oracle.importers.slice(1) }), oracle));
  assert.throws(() => assertResult(fake({ ...oracle, importers: [...oracle.importers, oracle.importers[0]] }), oracle));
  assert.throws(() => assertResult(fake({ entry: 'e', target: 't', importers: [] }), oracle));
});

test('exact duplicate edge tuple is rejected', () => {
  const report = reportFor(graphs[0], 2);
  report.edges.push({ ...report.edges[0] });
  const result = run(report, 't');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
