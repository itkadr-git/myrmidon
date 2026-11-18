import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dominators.mjs', import.meta.url));
const graphs = [
  { name: 'chain', nodes: ['a', 'b', 'c'], edges: [['a', 'b'], ['b', 'c']] },
  { name: 'diamond', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']] },
  { name: 'lazy and disconnected', nodes: ['a', 'b', 'c', 'x', 'y'], edges: [['a', 'b'], ['b', 'c', 'lazy'], ['x', 'y']] },
  { name: 'mixed eager and lazy', nodes: ['a', 'b', 'c', 'd', 'z'], edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'd', 'lazy'], ['d', 'z', 'lazy'], ['z', 'c']] },
];

// Reachability after removing a vertex supplies an independent dominator oracle.
function reachable(graph, removed) {
  if (removed === graph.nodes[0]) return new Set();
  const seen = new Set(), pending = [graph.nodes[0]];
  while (pending.length) {
    const node = pending.pop();
    if (node === removed || seen.has(node)) continue;
    seen.add(node);
    for (const [from, to, kind = 'eager'] of graph.edges) {
      if (from === node && kind === 'eager' && to !== removed) pending.push(to);
    }
  }
  return seen;
}

function expected(graph, target) {
  const entry = graph.nodes[0];
  return { entry, target, dominators: [...reachable(graph)].filter(candidate =>
    candidate === entry || candidate === target || !reachable(graph, candidate).has(target),
  ).sort() };
}

function report(graph, multiplicity, reverse) {
  const eager = reachable(graph);
  const modules = graph.nodes.map((path, i) => ({ path, bytes: (i + 1) * 17, eager: eager.has(path) }));
  const edges = graph.edges.flatMap(([from, to, kind = 'eager'], index) =>
    Array.from({ length: multiplicity }, (_, i) => ({ from, to, kind, specifier: `./edge-${index}-specifier-${i}` })),
  );
  return { entry: graph.nodes[0], modules: reverse ? modules.reverse() : modules, edges: reverse ? edges.reverse() : edges };
}

function check(actual, wanted) {
  assert.deepEqual(actual, wanted);
}

for (const graph of graphs) {
  test(`${graph.name}: parallel specifiers preserve every reachable dominator set`, () => {
    for (const multiplicity of [1, 2, 4]) {
      for (const reverse of [false, true]) {
        const input = report(graph, multiplicity, reverse);
        assert.equal(new Set(input.edges.map(e => JSON.stringify([e.from, e.specifier, e.kind, e.to]))).size, input.edges.length);
        for (const target of reachable(graph)) {
          const result = spawnSync(process.execPath, [cli, '-', target], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          check(JSON.parse(result.stdout), expected(graph, target));
        }
      }
    }
  });
}

test('oracle assertion rejects missing dominators, duplicates and constant output', () => {
  const wanted = expected(graphs[1], 'd');
  check(wanted, { entry: 'a', target: 'd', dominators: ['a', 'd'] });
  assert.throws(() => check({ ...wanted, dominators: ['d'] }, wanted));
  assert.throws(() => check({ ...wanted, dominators: ['a', 'a', 'd'] }, wanted));
  assert.throws(() => check({}, wanted));
  assert.throws(() => check(expected(graphs[0], 'c'), wanted));
});

test('an identical full edge tuple remains invalid', () => {
  const input = report(graphs[1], 2, false);
  input.edges.push({ ...input.edges[0] });
  const result = spawnSync(process.execPath, [cli, '-', 'd'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
