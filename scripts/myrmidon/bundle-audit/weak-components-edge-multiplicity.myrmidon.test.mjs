import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const graphs = [
  { name: 'chain', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'eager']] },
  { name: 'diamond', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'd', 'eager'], ['c', 'd', 'eager']] },
  { name: 'lazy bridge and disconnected singleton', nodes: ['a', 'b', 'c', 'd', 'z'], edges: [['a', 'b', 'eager'], ['b', 'c', 'lazy'], ['c', 'd', 'eager']] },
  { name: 'mixed eager and lazy', nodes: ['a', 'b', 'c', 'd', 'e', 'z'], edges: [['a', 'b', 'eager'], ['a', 'c', 'lazy'], ['b', 'd', 'eager'], ['c', 'd', 'lazy'], ['c', 'e', 'eager']] },
];

// Compute directed eager reachability from the entry, independent of the CLI.
function eagerNodes(graph) {
  const reachable = new Set(['a']);
  for (let changed = true; changed;) {
    changed = false;
    for (const [from, to, kind] of graph.edges) {
      if (kind === 'eager' && reachable.has(from) && !reachable.has(to)) {
        reachable.add(to);
        changed = true;
      }
    }
  }
  return reachable;
}

function makeReport(graph, multiplicity) {
  const eager = eagerNodes(graph);
  return {
    entry: 'a',
    modules: graph.nodes.map((path, i) => ({ path, bytes: (i + 1) * 7, eager: eager.has(path) })),
    edges: graph.edges.flatMap(([from, to, kind], i) =>
      Array.from({ length: multiplicity }, (_, n) => ({ from, to, kind, specifier: `edge-${i}-alias-${n}` }))),
  };
}

// Floyd-Warshall gives pairwise undirected reachability rather than traversing CLI output.
function expected(graph, mode) {
  const nodes = [...graph.nodes].sort();
  const reachable = nodes.map((a, i) => nodes.map((b, j) => i === j || graph.edges.some(([from, to, kind]) =>
    (mode === 'all' || kind === 'eager') && ((from === a && to === b) || (from === b && to === a)))));
  for (let k = 0; k < nodes.length; k++)
    for (let i = 0; i < nodes.length; i++)
      for (let j = 0; j < nodes.length; j++)
        reachable[i][j] ||= reachable[i][k] && reachable[k][j];
  const components = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes.some((_, j) => j < i && reachable[i][j])) continue;
    const paths = nodes.filter((_, j) => reachable[i][j]);
    components.push({ id: paths[0], paths, bytes: paths.reduce((sum, path) => sum + (graph.nodes.indexOf(path) + 1) * 7, 0) });
  }
  return { entry: 'a', components };
}

function run(report, mode) {
  return spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}

function assertResult(result, value) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), value);
}

for (const graph of graphs) {
  test(`${graph.name}: parallel specifiers preserve weak components`, () => {
    for (const mode of ['eager', 'all']) {
      const value = expected(graph, mode);
      for (const count of [1, 2, 4]) {
        const report = makeReport(graph, count);
        assert.equal(new Set(report.edges.map(edge => JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]))).size, report.edges.length);
        for (const reverseModules of [false, true]) for (const reverseEdges of [false, true]) {
          const input = { ...report, modules: reverseModules ? [...report.modules].reverse() : report.modules, edges: reverseEdges ? [...report.edges].reverse() : report.edges };
          assertResult(run(input, mode), value);
        }
      }
    }
  });
}

test('exact duplicate tuples are rejected in both modes', () => {
  const report = makeReport(graphs[0], 2);
  report.edges.push({ ...report.edges[0] });
  for (const mode of ['eager', 'all']) {
    const result = run(report, mode);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});

test('assertion rejects duplicated paths or components, wrong bytes, and constant output', () => {
  const value = expected(graphs[2], 'eager');
  const check = output => assertResult({ status: 0, stderr: '', stdout: JSON.stringify(output) }, value);
  const duplicatePath = structuredClone(value);
  duplicatePath.components[0].paths.push(duplicatePath.components[0].paths[0]);
  const duplicateComponent = structuredClone(value);
  duplicateComponent.components.push(structuredClone(duplicateComponent.components[0]));
  const wrongBytes = structuredClone(value);
  wrongBytes.components[0].bytes++;
  for (const bad of [duplicatePath, duplicateComponent, wrongBytes, { entry: 'a', components: [] }, expected(graphs[2], 'all')]) {
    assert.throws(() => check(bad), assert.AssertionError);
  }
});
