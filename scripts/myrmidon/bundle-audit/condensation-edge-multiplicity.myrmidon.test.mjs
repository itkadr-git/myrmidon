import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const graphs = [
  { name: 'chain', nodes: ['a', 'b', 'c'], edges: [['a', 'b', 'eager'], ['b', 'c', 'eager']] },
  { name: 'diamond', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'd', 'eager'], ['c', 'd', 'eager']] },
  { name: 'lazy and disconnected', nodes: ['a', 'b', 'c', 'x', 'y'], edges: [['a', 'b', 'eager'], ['b', 'c', 'lazy'], ['x', 'y', 'eager']] },
  { name: 'mixed lazy back edge', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['b', 'c', 'eager'], ['c', 'a', 'lazy'], ['b', 'd', 'lazy']] },
];

function reachable(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  for (const node of queue) for (const [from, to] of edges) {
    if (from === node && to !== null && !seen.has(to)) { seen.add(to); queue.push(to); }
  }
  return seen;
}

function reportFor(graph, multiplicity) {
  const eager = reachable('a', graph.edges.filter(([, , kind]) => kind === 'eager'));
  return {
    entry: 'a',
    modules: graph.nodes.map((path, index) => ({ path, bytes: (index + 1) * 7, eager: eager.has(path) })),
    edges: graph.edges.flatMap(([from, to, kind], index) =>
      Array.from({ length: multiplicity }, (_, variant) => ({ from, to, kind, specifier: `edge-${index}-specifier-${variant}` }))),
  };
}

// Mutual reachability is deliberately independent of the production SCC algorithm.
function oracle(graph, mode) {
  const edges = graph.edges.filter(([, , kind]) => mode === 'all' || kind === 'eager');
  const reach = new Map(graph.nodes.map(node => [node, reachable(node, edges)]));
  const remaining = new Set(graph.nodes);
  const components = [];
  const owner = new Map();
  for (const node of [...graph.nodes].sort()) {
    if (!remaining.has(node)) continue;
    const paths = [...remaining].filter(other => reach.get(node).has(other) && reach.get(other).has(node)).sort();
    for (const path of paths) { remaining.delete(path); owner.set(path, paths[0]); }
    components.push({ id: paths[0], paths, bytes: paths.reduce((sum, path) => sum + (graph.nodes.indexOf(path) + 1) * 7, 0) });
  }
  const pairs = new Set();
  for (const [from, to] of edges) {
    if (to !== null && owner.get(from) !== owner.get(to)) pairs.add(JSON.stringify([owner.get(from), owner.get(to)]));
  }
  const projected = [...pairs].map(pair => JSON.parse(pair)).sort(([a, b], [c, d]) => a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0);
  return { entry: 'a', components, edges: projected.map(([from, to]) => ({ from, to })) };
}

function run(report, mode) {
  return spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
}
function assertOutput(actual, expected) { assert.deepEqual(actual, expected); }

for (const graph of graphs) {
  test(`${graph.name}: multiplicity and input order preserve condensation`, () => {
    for (const mode of ['eager', 'all']) {
      const expected = oracle(graph, mode);
      for (const multiplicity of [1, 2, 4]) {
        const report = reportFor(graph, multiplicity);
        for (const reverseModules of [false, true]) for (const reverseEdges of [false, true]) {
          const input = { ...report, modules: reverseModules ? [...report.modules].reverse() : report.modules, edges: reverseEdges ? [...report.edges].reverse() : report.edges };
          const result = run(input, mode);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assertOutput(JSON.parse(result.stdout), expected);
        }
      }
    }
  });
}

test('lazy back edge joins components only in all mode', () => {
  const graph = graphs[3];
  assert.deepEqual(oracle(graph, 'eager').components.map(c => c.paths), [['a'], ['b'], ['c'], ['d']]);
  assert.deepEqual(oracle(graph, 'all').components.map(c => c.paths), [['a', 'b', 'c'], ['d']]);
});

test('exact duplicate tuple is rejected in both modes', () => {
  const report = reportFor(graphs[0], 2);
  report.edges.push({ ...report.edges[0] });
  for (const mode of ['eager', 'all']) {
    const result = run(report, mode);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});

test('the same assertion rejects duplicated paths, components, bytes and missing edges', () => {
  const expected = oracle(graphs[1], 'all');
  const mutations = [
    result => result.components[0].paths.push(result.components[0].paths[0]),
    result => result.components.push(structuredClone(result.components[0])),
    result => result.components[0].bytes++,
    result => result.edges.pop(),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(expected);
    mutate(bad);
    assert.throws(() => assertOutput(bad, expected), assert.AssertionError);
  }
});
