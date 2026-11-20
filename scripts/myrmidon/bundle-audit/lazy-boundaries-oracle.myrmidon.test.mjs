import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));

// Repeated relaxation is independent of the CLI's adjacency-list traversal.
function closure(entry, edges) {
  const reached = new Set([entry]);
  let previous;
  do {
    previous = reached.size;
    for (const edge of edges) {
      if (edge.kind === 'eager' && edge.to !== null && reached.has(edge.from)) reached.add(edge.to);
    }
  } while (reached.size !== previous);
  return reached;
}

function graph(seed) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const paths = Array.from({ length: 10 }, (_, i) => `module-${i}`);
  const edges = [];
  const add = (from, specifier, kind, to) => edges.push({ from: paths[from], specifier, kind, to: to === null ? null : paths[to] });
  // Keep modules 0..2 eager and 3..9 lazy while varying the internal graphs.
  add(0, 'static-a', 'eager', 1);
  add(1, 'static-b', 'eager', 2);
  add(2, 'cycle', 'eager', 0);
  add(0, 'alternate', 'lazy', 2);
  add(0, 'self', 'lazy', 0);
  add(0, 'missing', 'lazy', null);
  add(0, 'alias-z', 'lazy', 3);
  add(0, 'alias-a', 'lazy', 3);
  add(1, 'zero', 'lazy', 4);
  add(3, 'lazy-source', 'lazy', 4);
  add(3, 'lazy-cycle-a', 'eager', 5);
  add(5, 'lazy-cycle-b', 'eager', 3);
  for (let i = 0; i < 35; i++) {
    const from = next() % 10;
    const target = from < 3 ? next() % 3 : 3 + next() % 7;
    const kind = next() % 2 ? 'lazy' : 'eager';
    add(from, `generated-${i}`, kind, target);
    if (i % 4 === 0) add(from, `frontier-${i}`, 'lazy', 3 + next() % 7);
  }
  const eager = closure(paths[0], edges);
  const modules = paths.map((path, i) => ({ path, bytes: i === 4 ? 0 : next() % 1000 + 1, eager: eager.has(path) }));
  return { entry: paths[0], modules, edges };
}

function oracle(report) {
  const reached = closure(report.entry, report.edges);
  const bytes = new Map(report.modules.map(module => [module.path, module.bytes]));
  // Documented boundary semantics (bundle-audit README, "Lazy boundaries"):
  // a boundary carries the bytes of its target plus every module reachable
  // from it through EAGER edges, excluding modules already eagerly reached
  // from the entry; each module counts once per boundary; nested lazy edges
  // are not followed. #4010's oracle used only the target's own bytes, so it
  // disagreed with the CLI (e.g. seed 1: 584 vs 587) on every seeded graph
  // where a boundary target eagerly pulls in more lazy-reachable modules.
  // Implemented independently of the CLI (linear edge scans instead of its
  // adjacency lists) so agreement is still a real cross-check.
  const closureBytes = new Map();
  const bytesFor = target => {
    if (closureBytes.has(target)) return closureBytes.get(target);
    const seen = new Set([target]);
    const pending = [target];
    let total = 0;
    for (let i = 0; i < pending.length; i++) {
      const path = pending[i];
      total += bytes.get(path);
      for (const edge of report.edges) {
        if (edge.kind === 'eager' && edge.to !== null && edge.from === path && !reached.has(edge.to) && !seen.has(edge.to)) {
          seen.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    closureBytes.set(target, total);
    return total;
  };
  const result = [];
  for (const { from, specifier, kind, to } of report.edges) {
    if (kind === 'lazy' && to !== null && reached.has(from) && !reached.has(to)) {
      result.push({ from, specifier, to, bytes: bytesFor(to) });
    }
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  result.sort((a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.to, b.to));
  return { entry: report.entry, boundaries: result };
}

test('seeded startup frontier agrees with a fixed-point oracle', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  for (let seed = 1; seed <= 30; seed++) {
    const report = graph(seed);
    const expected = oracle(report);
    for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
      writeFileSync(path, JSON.stringify(input));
      const actual = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10000 });
      assert.equal(actual.status, 0, `seed ${seed}: ${actual.error || actual.stderr}`);
      assert.equal(actual.stderr, '', `seed ${seed}`);
      assert.deepEqual(JSON.parse(actual.stdout), expected, `seed ${seed}`);
    }
  }
});
