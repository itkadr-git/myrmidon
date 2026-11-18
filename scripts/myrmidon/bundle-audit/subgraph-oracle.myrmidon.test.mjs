import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Repeated whole-edge relaxation is independent of the CLI's adjacency traversal.
function fixedPoint(root, edges, mode) {
  const reached = new Set([root]);
  let previous;
  do {
    previous = reached.size;
    for (const edge of edges) {
      if (reached.has(edge.from) && edge.to !== null && (mode === 'all' || edge.kind === 'eager')) reached.add(edge.to);
    }
  } while (previous !== reached.size);
  return reached;
}

function expected(report, root, mode) {
  const reached = fixedPoint(root, report.edges, mode);
  const edges = report.edges.filter(edge => reached.has(edge.from) && (mode === 'all' || edge.kind === 'eager'));
  edges.sort((a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.kind, b.kind) || (a.to === b.to ? 0 : a.to === null ? -1 : b.to === null ? 1 : compare(a.to, b.to)));
  return { root, mode, modules: report.modules.filter(m => reached.has(m.path)).sort((a, b) => compare(a.path, b.path)), edges, unknown: edges.filter(edge => edge.to === null) };
}

function graph(seed) {
  let state = seed;
  const random = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const paths = ['entry', 'A', 'b', 'lazy', 'island', 'z'];
  const edges = [
    { from: 'entry', specifier: 'cycle', kind: 'eager', to: 'A' },
    { from: 'A', specifier: 'back', kind: 'eager', to: 'entry' },
    { from: 'entry', specifier: 'lazy-only', kind: 'lazy', to: 'lazy' },
    { from: 'lazy', specifier: 'external', kind: 'eager', to: null },
    { from: 'island', specifier: 'external', kind: 'lazy', to: null },
  ];
  // Keep lazy and island disconnected from eager entry so every seed tests the mode boundary.
  for (let i = 0; i < 12; i++) {
    const from = paths[random(paths.length)];
    const to = paths[random(paths.length)];
    const kind = random(2) ? 'eager' : 'lazy';
    if (kind === 'eager' && (from === 'entry' || from === 'A' || from === 'b' || from === 'z') && (to === 'lazy' || to === 'island')) continue;
    edges.push({ from, specifier: `generated-${i}`, kind, to: random(5) === 0 ? null : to });
  }
  const eager = fixedPoint('entry', edges, 'eager');
  const modules = paths.map((path, i) => ({ path, bytes: seed * 10 + i, eager: eager.has(path), marker: `seed-${seed}-${path}` }));
  return { entry: 'entry', modules: modules.reverse(), edges: edges.reverse() };
}

test('seeded projections match independent fixed-point oracle for every root and mode', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-oracle-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'report.json');
  for (let seed = 1; seed <= 25; seed++) {
    const report = graph(seed);
    writeFileSync(file, JSON.stringify(report));
    for (const { path: root } of report.modules) for (const mode of ['eager', 'all']) {
      const result = spawnSync(process.execPath, [cli, file, root, mode], { encoding: 'utf8', timeout: 10000 });
      const context = `seed=${seed} root=${root} mode=${mode}`;
      assert.equal(result.status, 0, `${context}: ${result.error || result.stderr}`);
      assert.equal(result.stderr, '', context);
      assert.deepEqual(JSON.parse(result.stdout), expected(report, root, mode), context);
    }
  }
});
