import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const edge = (from, specifier, to, kind = 'eager') => ({ from, specifier, to, kind });
const graphs = [
  { name: 'chain', weights: { root: 3, a: 5, b: 7 }, edges: [edge('root', 'a', 'a'), edge('a', 'b', 'b')], selection: ['root', 'a'] },
  { name: 'diamond and cycle', weights: { root: 2, a: 3, b: 5, shared: 7 }, edges: [edge('root', 'a', 'a'), edge('root', 'b', 'b'), edge('a', 'shared', 'shared'), edge('b', 'shared', 'shared'), edge('shared', 'a', 'a')], selection: ['root', 'a'] },
  { name: 'lazy and unreachable', weights: { root: 1, a: 4, lazy: 8, hidden: 9 }, edges: [edge('root', 'a', 'a'), edge('root', 'lazy', 'lazy', 'lazy'), edge('lazy', 'hidden', 'hidden')], selection: ['root', 'a'] },
  { name: 'parallel aliases', weights: { root: 2, a: 6, child: 4 }, edges: [edge('root', 'first', 'a'), edge('root', 'alias', 'a'), edge('a', 'child', 'child')], selection: ['root', 'first'] },
];

// Traverse the input edge list directly, excluding only the selected import.
function reachable(graph, excluded = false) {
  const paths = new Set(['root']);
  const queue = ['root'];
  for (let i = 0; i < queue.length; i++) {
    for (const e of graph.edges) {
      if (e.from !== queue[i] || e.kind !== 'eager' || e.to === null) continue;
      if (excluded && e.from === graph.selection[0] && e.specifier === graph.selection[1]) continue;
      if (!paths.has(e.to)) { paths.add(e.to); queue.push(e.to); }
    }
  }
  return paths;
}
function expected(graph, k, c) {
  const before = reachable(graph), after = reachable(graph, true);
  const total = paths => ({ modules: paths.size, bytes: [...paths].reduce((sum, path) => sum + k * graph.weights[path] + c, 0) });
  const b = total(before), a = total(after);
  const selected = graph.edges.find(e => e.from === graph.selection[0] && e.specifier === graph.selection[1]);
  return { entry: 'root', selected: { from: selected.from, specifier: selected.specifier, to: selected.to }, before: b, after: a, removedPaths: [...before].filter(path => !after.has(path)).sort(), savedBytes: b.bytes - a.bytes };
}
function assertResult(result, want) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(want)}\n`);
}

test('affine weights preserve lazy impact topology and transform set totals', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'weight-transform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  for (const graph of graphs) {
    const eager = reachable(graph);
    const topology = expected(graph, 1, 0);
    for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
      const want = expected(graph, k, c);
      assert.deepEqual(want.removedPaths, topology.removedPaths, graph.name);
      assert.equal(want.before.modules, topology.before.modules, graph.name);
      assert.equal(want.after.modules, topology.after.modules, graph.name);
      if (graph.name === 'parallel aliases') assert.equal(want.savedBytes, 0);
      const modules = Object.entries(graph.weights).map(([path, bytes]) => ({ path, bytes: k * bytes + c, eager: eager.has(path) }));
      for (const reverse of [false, true]) {
        const report = { entry: 'root', modules: reverse ? [...modules].reverse() : modules, edges: reverse ? [...graph.edges].reverse() : graph.edges };
        const text = JSON.stringify(report);
        writeFileSync(file, text);
        const result = spawnSync(process.execPath, [cli, file, ...graph.selection], { encoding: 'utf8', timeout: 10000 });
        assertResult(result, want);
        assert.equal(readFileSync(file, 'utf8'), text);
      }
    }
  }
});

test('assertion rejects a wrong byte total', () => {
  const want = expected(graphs[0], 3, 11);
  const wrong = { ...want, before: { ...want.before, bytes: want.before.bytes + 1 } };
  assert.throws(() => assertResult({ status: 0, stderr: '', stdout: `${JSON.stringify(wrong)}\n` }, want), assert.AssertionError);
});
