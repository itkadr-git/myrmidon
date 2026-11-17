import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const graphs = [
  { name: 'chain', paths: ['entry.js', 'a/x.js', 'a/nested/y.js'], weights: [2, 3, 5], edges: [edge('entry.js', 'a/x.js'), edge('a/x.js', 'a/nested/y.js')] },
  { name: 'diamond', paths: ['entry.js', 'a/x.js', 'a/y.js', 'a/nested/z.js'], weights: [1, 4, 7, 9], edges: [edge('entry.js', 'a/x.js'), edge('entry.js', 'a/y.js'), edge('a/x.js', 'a/nested/z.js'), edge('a/y.js', 'a/nested/z.js')] },
  { name: 'lazy and unreachable cycle', paths: ['entry.js', 'a/x.js', 'a/lazy.js', 'a/nested/u.js'], weights: [3, 6, 8, 10], edges: [edge('entry.js', 'a/x.js'), edge('entry.js', 'a/lazy.js', 'lazy'), edge('a/lazy.js', 'a/nested/u.js'), edge('a/nested/u.js', 'a/lazy.js')] },
  { name: 'aliases and parallel imports', paths: ['entry.js', 'a/x.js', 'a/y.js', 'other.js'], weights: [5, 1, 4, 2], edges: [edge('entry.js', 'a/x.js', 'eager', './x'), edge('entry.js', 'a/x.js', 'eager', 'alias'), edge('a/x.js', 'a/y.js'), edge('entry.js', 'other.js', 'lazy')] },
];

// Traverse from the entry independently of module flags and deduplicate graph visits.
function reachable(graph) {
  const seen = new Set([graph.paths[0]]);
  const queue = [graph.paths[0]];
  for (let i = 0; i < queue.length; i++) {
    for (const e of graph.edges) {
      if (e.from === queue[i] && e.kind === 'eager' && e.to !== null && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

function oracle(graph, k, c) {
  const eager = reachable(graph);
  const names = [...new Set(graph.paths.map(path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'))].sort();
  return { entry: graph.paths[0], directories: names.map(directory => {
    const indexes = graph.paths.map((path, i) => ({ path, i })).filter(({ path }) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.') === directory);
    const selected = indexes.filter(({ path }) => eager.has(path));
    const sum = list => list.reduce((total, { i }) => total + graph.weights[i], 0);
    return { directory, modules: indexes.length, eagerModules: selected.length, totalBytes: k * sum(indexes) + c * indexes.length, eagerBytes: k * sum(selected) + c * selected.length };
  }) };
}

function report(graph, k, c, reverse) {
  const eager = reachable(graph);
  const modules = graph.paths.map((path, i) => ({ path, bytes: k * graph.weights[i] + c, eager: eager.has(path) }));
  return { entry: graph.paths[0], modules: reverse ? modules.reverse() : modules, edges: reverse ? [...graph.edges].reverse() : graph.edges };
}

const assertOutput = (actual, expected) => assert.equal(actual, JSON.stringify(expected) + '\n');

test('directory rollup follows affine weights across graphs and input orders', () => {
  for (const graph of graphs) {
    for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
      const expected = oracle(graph, k, c);
      for (const reverse of [false, true]) {
        const input = JSON.stringify(report(graph, k, c, reverse));
        const result = spawnSync(process.execPath, [cli, '-'], { input, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, `${graph.name}: ${result.stderr}`);
        assert.equal(result.stderr, '');
        assertOutput(result.stdout, expected);
      }
    }
  }
});

test('the exact-output assertion rejects a wrong byte count and empty output', () => {
  const expected = oracle(graphs[1], 3, 2);
  const wrong = structuredClone(expected);
  wrong.directories[0].totalBytes++;
  assert.throws(() => assertOutput(JSON.stringify(wrong) + '\n', expected), assert.AssertionError);
  assert.throws(() => assertOutput('', expected), assert.AssertionError);
});
