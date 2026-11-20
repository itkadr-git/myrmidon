import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${to}` });

// Fixture reachability is a BFS; it does not use the dominator implementation.
function reachable(entry, edges, removed = null) {
  if (entry === removed) return new Set();
  const seen = new Set([entry]), queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    for (const e of edges) {
      if (e.kind === 'eager' && e.from === queue[i] && e.to !== removed && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

function oracle(names, edges, entry, target) {
  return names.filter(name => name === entry || name === target || !reachable(entry, edges, name).has(target)).sort();
}

function graphs() {
  let seed = 0x17d01a7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const cases = [
    { names: ['a', 'b', 'c'], edges: [edge('a', 'b'), edge('b', 'c')] },
    { names: ['a', 'b', 'c', 'd', 'e', 'f'], edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'b'), edge('e', 'f'), edge('f', 'e')] },
  ];
  for (let i = 2; i < 30; i++) {
    const names = Array.from({ length: 3 + random() % 6 }, (_, n) => String.fromCharCode(97 + n));
    const edges = [];
    for (const from of names) for (const to of names) {
      if (random() % 5 === 0) edges.push(edge(from, to));
    }
    cases.push({ names, edges });
  }
  return cases;
}

function run(path, target) {
  const result = spawnSync(process.execPath, [cli, path, target], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `CLI failed: ${result.error || result.stderr}`);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('vertex-removal oracle matches every eager-reachable target in 30 deterministic graphs', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dominator-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'report.json');
  for (const [index, { names, edges }] of graphs().entries()) {
    const entry = names[0], eager = reachable(entry, edges);
    const report = { entry, modules: names.map(path => ({ path, bytes: 0, eager: eager.has(path) })), edges };
    for (const target of [...eager].sort()) {
      const expected = { entry, target, dominators: oracle(names, edges, entry, target) };
      writeFileSync(path, JSON.stringify(report));
      assert.deepEqual(run(path, target), expected, `graph ${index}, target ${target}`);
      const bypass = { ...report, edges: [...edges, edge(entry, target, 'lazy')] };
      writeFileSync(path, JSON.stringify(bypass));
      assert.deepEqual(run(path, target), expected, `graph ${index}, target ${target}, lazy bypass`);
    }
  }
});
