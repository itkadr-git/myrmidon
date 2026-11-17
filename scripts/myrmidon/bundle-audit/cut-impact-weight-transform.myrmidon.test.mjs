import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const edge = (from, to, specifier = to, kind = 'eager') => ({ from, to, specifier, kind });
const graphs = [
  { name: 'chain', weights: { entry: 2, a: 3, b: 5, end: 7 }, edges: [edge('entry', 'a'), edge('a', 'b'), edge('b', 'end')] },
  { name: 'diamond', weights: { entry: 2, a: 3, b: 5, end: 7 }, edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'end'), edge('b', 'end')] },
  { name: 'lazy and disconnected cycle', weights: { entry: 2, a: 3, off: 5, other: 7 }, edges: [edge('entry', 'a'), edge('entry', 'off', 'lazy-off', 'lazy'), edge('off', 'other'), edge('other', 'off')] },
  { name: 'aliases and reachable cycle', weights: { entry: 2, a: 3, end: 5 }, edges: [edge('entry', 'a', './a'), edge('entry', 'a', '@alias/a'), edge('a', 'end'), edge('end', 'a')] },
];

// Traverse only eager edges, with a fresh queue and visited set for each removal.
function reachable(entry, edges, removed) {
  const seen = new Set();
  const queue = entry === removed ? [] : [entry];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) {
      if (edge.kind === 'eager' && edge.from === current && edge.to !== null && edge.to !== removed && !seen.has(edge.to)) queue.push(edge.to);
    }
  }
  return seen;
}

function oracle(graph, removed, k, c) {
  const before = reachable('entry', graph.edges, null);
  const after = reachable('entry', graph.edges, removed);
  const lostPaths = [...before].filter(path => !after.has(path)).sort();
  const originalBytes = lostPaths.reduce((sum, path) => sum + graph.weights[path], 0);
  return { entry: 'entry', removed, lostPaths, lostBytes: k * originalBytes + c * lostPaths.length };
}

function makeReport(graph, k, c, reverse) {
  const eager = reachable('entry', graph.edges, null);
  const modules = Object.entries(graph.weights).map(([path, bytes]) => ({ path, bytes: k * bytes + c, eager: eager.has(path) }));
  const edges = [...graph.edges];
  if (reverse) { modules.reverse(); edges.reverse(); }
  return { entry: 'entry', modules, edges };
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

test('cut impact obeys affine weights for independent reachability and input permutations', () => {
  for (const graph of graphs) {
    for (const removed of Object.keys(graph.weights)) {
      const baseline = oracle(graph, removed, 1, 0);
      for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
        const expected = oracle(graph, removed, k, c);
        assert.deepEqual(expected.lostPaths, baseline.lostPaths);
        assert.equal(expected.lostBytes, k * baseline.lostBytes + c * baseline.lostPaths.length);
        for (const reverse of [false, true]) {
          const result = spawnSync(process.execPath, [cli, removed], { input: JSON.stringify(makeReport(graph, k, c, reverse)), encoding: 'utf8', timeout: 10000 });
          assertOutput(result, expected);
        }
      }
    }
  }
});

test('the output assertion rejects incorrect bytes and empty results', () => {
  const expected = oracle(graphs[0], 'a', 3, 2);
  const wrong = { ...expected, lostBytes: expected.lostBytes + 1 };
  assert.throws(() => assertOutput({ status: 0, stderr: '', stdout: `${JSON.stringify(wrong)}\n` }, expected), assert.AssertionError);
  assert.throws(() => assertOutput({ status: 0, stderr: '', stdout: '' }, expected), assert.AssertionError);
});
