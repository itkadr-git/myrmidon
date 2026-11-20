import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const edge = (from, to, kind = 'eager') => ({ from, to, kind });
const graphs = [
  { name: 'chain', nodes: [['entry', 3], ['a', 5], ['tail', 11]], edges: [edge('entry', 'a'), edge('a', 'tail')], selected: 0 },
  { name: 'diamond', nodes: [['entry', 2], ['a', 3], ['b', 5], ['shared', 7]], edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'shared'), edge('b', 'shared')], selected: 2 },
  { name: 'lazy and disconnected', nodes: [['entry', 3], ['a', 7], ['lazy', 13], ['island', 17]], edges: [edge('entry', 'a'), edge('entry', 'lazy', 'lazy'), edge('lazy', 'island')], selected: 0 },
  { name: 'mixed eager and lazy', nodes: [['entry', 5], ['a', 11], ['b', 17], ['lazy', 23]], edges: [edge('entry', 'a'), edge('a', 'b'), edge('b', 'a'), edge('entry', 'lazy', 'lazy'), edge('lazy', 'b')], selected: 1 },
];

// Compute reachability from the fixture rather than the CLI result.
function closure(entry, edges, excluded) {
  const reached = new Set([entry]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (e !== excluded && e.kind === 'eager' && reached.has(e.from) && !reached.has(e.to)) {
        reached.add(e.to);
        changed = true;
      }
    }
  }
  return reached;
}
function fixture(graph, multiplicity) {
  const edges = graph.edges.flatMap((e, index) => Array.from({ length: multiplicity }, (_, n) => ({ ...e, specifier: `edge-${index}-${n}` })));
  const reachable = closure('entry', edges);
  return { entry: 'entry', modules: graph.nodes.map(([path, bytes]) => ({ path, bytes, eager: reachable.has(path) })), edges };
}
function oracle(report, selected) {
  const before = closure(report.entry, report.edges);
  const after = closure(report.entry, report.edges, selected);
  const totals = paths => ({ modules: paths.size, bytes: report.modules.filter(m => paths.has(m.path)).reduce((sum, m) => sum + m.bytes, 0) });
  const removedPaths = [...before].filter(path => !after.has(path)).sort();
  const beforeTotals = totals(before), afterTotals = totals(after);
  return { entry: report.entry, selected: { from: selected.from, specifier: selected.specifier, to: selected.to }, before: beforeTotals, after: afterTotals, removedPaths, savedBytes: beforeTotals.bytes - afterTotals.bytes };
}
function check(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}
function run(dir, report, selected) {
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  return spawnSync(process.execPath, [cli, file, selected.from, selected.specifier], { encoding: 'utf8', timeout: 10000 });
}
function directory(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-multiplicity');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parallel specifiers remove exactly the selected tuple across graph topologies and orders', t => {
  const dir = directory(t);
  for (const graph of graphs) {
    let baseline;
    for (const count of [1, 2, 4]) {
      const report = fixture(graph, count);
      const selectedEdges = report.edges.slice(graph.selected * count, (graph.selected + 1) * count);
      for (const selected of selectedEdges) {
        const expected = oracle(report, selected);
        if (!baseline) baseline = expected.before;
        assert.deepEqual(expected.before, baseline, graph.name);
        if (count > 1) {
          assert.equal(expected.savedBytes, 0, graph.name);
          assert.deepEqual(expected.removedPaths, [], graph.name);
          assert.deepEqual(expected.after, expected.before, graph.name);
        }
        if (graph.name === 'chain' && count === 1) {
          assert.equal(expected.savedBytes, 16);
          assert.deepEqual(expected.removedPaths, ['a', 'tail']);
        }
        if (graph.name === 'diamond') assert.equal(expected.savedBytes, 0);
        for (const reversed of [false, true]) {
          const input = reversed ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
          check(run(dir, input, selected), expected);
        }
      }
    }
  }
});

test('assertion rejects inflated bytes and duplicate removed paths', () => {
  const report = fixture(graphs[0], 1), expected = oracle(report, report.edges[0]);
  const result = value => ({ status: 0, stderr: '', stdout: JSON.stringify(value) });
  assert.throws(() => check(result({ ...expected, savedBytes: expected.savedBytes + 1 }), expected));
  assert.throws(() => check(result({ ...expected, removedPaths: [...expected.removedPaths, expected.removedPaths[0]] }), expected));
  assert.throws(() => check(result({}), expected));
});

test('an exact duplicate edge tuple remains invalid', t => {
  const dir = directory(t), report = fixture(graphs[0], 2), selected = report.edges[0];
  report.edges.push({ ...selected });
  const result = run(dir, report, selected);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: graph\n');
});
