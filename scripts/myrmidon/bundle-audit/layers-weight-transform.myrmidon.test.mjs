import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const graphs = [
  { name: 'chain', weights: { e: 3, a: 5, b: 7 }, edges: [edge('e', 'a'), edge('a', 'b')] },
  { name: 'diamond', weights: { e: 2, a: 3, b: 5, c: 11 }, edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 'c'), edge('b', 'c')] },
  { name: 'lazy and disconnected', weights: { e: 1, a: 4, b: 8, lazy: 6, isolated: 9 }, edges: [edge('e', 'a'), edge('a', 'b'), edge('e', 'b', 'lazy'), edge('e', 'lazy', 'lazy'), edge('isolated', 'lazy')] },
  { name: 'aliases and cycle', weights: { e: 7, a: 2, b: 4 }, edges: [edge('e', 'a', 'eager', './a'), edge('e', 'a', 'eager', 'alias-a'), edge('a', 'b'), edge('b', 'a')] },
];

// Expand frontiers as sets, independently of the CLI's queue and accumulation.
function model(graph, k, c) {
  let frontier = new Set(['e']);
  const visited = new Set();
  const layers = [];
  while (frontier.size) {
    const paths = [...frontier].sort();
    paths.forEach(path => visited.add(path));
    layers.push({ depth: layers.length, paths, bytes: k * paths.reduce((sum, path) => sum + graph.weights[path], 0) + c * paths.length });
    const next = new Set();
    for (const { from, to, kind } of graph.edges) {
      if (kind === 'eager' && to !== null && frontier.has(from) && !visited.has(to)) next.add(to);
    }
    frontier = next;
  }
  return { entry: 'e', layers, unreachable: Object.keys(graph.weights).filter(path => !visited.has(path)).sort() };
}

function report(graph, k, c, reverse) {
  const reachable = new Set(model(graph, 1, 0).layers.flatMap(layer => layer.paths));
  const modules = Object.entries(graph.weights).map(([path, bytes]) => ({ path, bytes: k * bytes + c, eager: reachable.has(path) }));
  return { entry: 'e', modules: reverse ? modules.reverse() : modules, edges: reverse ? [...graph.edges].reverse() : graph.edges };
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

for (const graph of graphs) {
  test(`${graph.name}: affine weights preserve eager BFS layers`, () => {
    for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) for (const reverse of [false, true]) {
      const input = report(graph, k, c, reverse);
      const actual = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
      assertOutput(actual, model(graph, k, c));
    }
  });
}

test('negative control rejects a wrong byte count through the same assertion', () => {
  const expected = model(graphs[1], 3, 2);
  const wrong = structuredClone(expected);
  wrong.layers[1].bytes++;
  assert.throws(() => assertOutput({ status: 0, stderr: '', stdout: `${JSON.stringify(wrong)}\n` }, expected), assert.AssertionError);
});
