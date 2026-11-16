import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-explain.mjs');
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const report = (nodes, edges) => ({ entry: nodes[0], modules: nodes.map(path => ({ path, bytes: 0, eager: false })), edges });

// Enumerate simple paths without relying on the CLI's breadth-first search.
function oracle(graph, target) {
  const paths = [];
  function visit(path) {
    const last = path[path.length - 1];
    if (last === target) { paths.push(path); return; }
    for (const e of graph.edges) {
      if (e.kind === 'eager' && e.from === last && e.to !== null && !path.includes(e.to)) visit([...path, e.to]);
    }
  }
  visit([graph.entry]);
  paths.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  });
  return paths[0] ?? [];
}

function check(t, graph, targets) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'explain-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  for (const target of targets) {
    const expected = oracle(graph, target);
    let original;
    for (const reverse of [false, true]) {
      const input = reverse ? { ...graph, modules: [...graph.modules].reverse(), edges: [...graph.edges].reverse() } : graph;
      writeFileSync(file, JSON.stringify(input));
      const result = spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.entry, graph.entry);
      assert.equal(output.target, target);
      assert.equal(output.reachable, expected.length > 0);
      assert.deepEqual(output.path, expected);
      if (reverse) assert.equal(result.stdout, original);
      else original = result.stdout;
    }
  }
}

test('seeded small graphs agree with exhaustive simple eager paths', t => {
  let state = 0x14214;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = 0; i < 30; i++) {
    const count = 3 + random() % 5;
    const nodes = Array.from({ length: count }, (_, n) => `node-${n}`);
    const edges = [];
    for (const from of nodes) for (const to of nodes) {
      if (from !== to && random() % 4 === 0) edges.push(edge(from, to, random() % 3 === 0 ? 'lazy' : 'eager'));
    }
    check(t, report(nodes, edges), nodes);
  }
});

test('entry, unreachable, lazy bypass, shared tail and shorter non-lexical path', t => {
  const nodes = ['entry', 'a', 'b', 'c', 'tail', 'target', 'isolated'];
  const edges = [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'c'), edge('c', 'tail'), edge('b', 'tail'), edge('a', 'tail'), edge('tail', 'target'), edge('entry', 'target', 'lazy'), edge('target', 'entry')];
  check(t, report(nodes, edges), nodes);
});

test('lexically first branch is not necessarily the shortest', t => {
  const nodes = ['entry', 'a', 'b', 'c', 'target'];
  check(t, report(nodes, [edge('entry', 'a'), edge('a', 'c'), edge('c', 'target'), edge('entry', 'b'), edge('b', 'target')]), ['target']);
});
