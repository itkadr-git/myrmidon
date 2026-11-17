import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const graphs = [
  { name: 'chain', weights: { a: 2, b: 3, c: 7 }, edges: [edge('a', 'b'), edge('b', 'c')] },
  { name: 'diamond', weights: { a: 1, b: 3, c: 5, d: 7, e: 9 }, edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'e')] },
  { name: 'lazy and unreachable', weights: { a: 4, b: 6, c: 8, x: 10, y: 12 }, edges: [edge('a', 'b'), edge('a', 'x', 'lazy'), edge('x', 'y'), edge('b', 'c', 'lazy')] },
  { name: 'aliases and cycles', weights: { a: 1, b: 4, c: 8, d: 11 }, edges: [edge('a', 'b', 'eager', './b'), edge('a', 'b', 'eager', 'alias-b'), edge('a', 'c'), edge('b', 'b'), edge('c', 'd'), edge('d', 'c')] },
];

// Traverse from the entry independently of module order and deduplicate visits.
function reachable(graph) {
  const seen = new Set();
  function visit(path) {
    if (seen.has(path)) return;
    seen.add(path);
    for (const e of graph.edges) if (e.from === path && e.kind === 'eager' && e.to !== null) visit(e.to);
  }
  visit('a');
  return seen;
}
function expected(graph, k, c) {
  const paths = [...reachable(graph)].filter(path => !graph.edges.some(e => e.from === path && e.kind === 'eager' && e.to !== null)).sort();
  const sinks = paths.map(path => ({ path, bytes: k * graph.weights[path] + c }));
  return { entry: 'a', sinks, sinkBytes: sinks.reduce((sum, sink) => sum + sink.bytes, 0) };
}
function check(actual, wanted) {
  assert.deepStrictEqual(actual, wanted);
}
function run(report) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(parsed) + '\n');
  return parsed;
}

for (const graph of graphs) {
  test(`${graph.name}: affine sink weights and order independence`, () => {
    const reached = reachable(graph);
    const baseline = expected(graph, 1, 0);
    for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
      const wanted = expected(graph, k, c);
      assert.deepStrictEqual(wanted.sinks.map(s => s.path), baseline.sinks.map(s => s.path));
      const modules = Object.entries(graph.weights).map(([path, bytes]) => ({ path, bytes: k * bytes + c, eager: reached.has(path) }));
      for (const reverse of [false, true]) {
        const report = { entry: 'a', modules: reverse ? [...modules].reverse() : modules, edges: reverse ? [...graph.edges].reverse() : graph.edges };
        check(run(report), wanted);
      }
    }
  });
}

test('negative control rejects an incorrect sink cost', () => {
  const wanted = expected(graphs[1], 3, 2);
  const wrong = structuredClone(wanted);
  wrong.sinks[0].bytes++;
  assert.throws(() => check(wrong, wanted), assert.AssertionError);
});
