import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Mutual reachability defines SCC membership independently of traversal order.
function oracle(report, mode) {
  const paths = report.modules.map(m => m.path).sort(cmp);
  const n = paths.length;
  const reach = paths.map((_, i) => paths.map((_, j) => i === j));
  const selected = report.edges.filter(e => e.to !== null && (mode === 'all' || e.kind === 'eager'));
  for (const e of selected) reach[paths.indexOf(e.from)][paths.indexOf(e.to)] = true;
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    reach[i][j] ||= reach[i][k] && reach[k][j];
  }
  const components = [];
  const owner = new Map();
  for (let i = 0; i < n; i++) {
    if (owner.has(paths[i])) continue;
    const members = paths.filter((_, j) => reach[i][j] && reach[j][i]);
    const id = members[0];
    for (const path of members) owner.set(path, id);
    components.push({ id, paths: members, bytes: members.reduce((sum, path) => sum + report.modules.find(m => m.path === path).bytes, 0) });
  }
  const pairs = new Map();
  for (const e of selected) {
    const from = owner.get(e.from), to = owner.get(e.to);
    if (from !== to) pairs.set(JSON.stringify([from, to]), { from, to });
  }
  const edges = [...pairs.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { entry: report.entry, components, edges };
}

function assertOutput(actual, expected, report) {
  assert.deepEqual(actual, expected);
  const paths = actual.components.flatMap(c => c.paths);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual([...paths].sort(cmp), report.modules.map(m => m.path).sort(cmp));
  const ids = actual.components.map(c => c.id);
  const reach = ids.map(() => ids.map(() => false));
  for (const { from, to } of actual.edges) {
    const i = ids.indexOf(from), j = ids.indexOf(to);
    assert.ok(i >= 0 && j >= 0);
    reach[i][j] = true;
  }
  for (let k = 0; k < ids.length; k++) for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
    reach[i][j] ||= reach[i][k] && reach[k][j];
  }
  assert.ok(ids.every((_, i) => !reach[i][i]), 'projected graph must be acyclic');
}

function report(n, pairs) {
  const modules = Array.from({ length: n }, (_, i) => ({ path: String.fromCharCode(97 + i), bytes: i * 3, eager: i % 2 === 0 }));
  const edges = pairs.map(([from, to, kind = 'eager'], i) => ({ from: modules[from].path, to: to === null ? null : modules[to].path, kind, specifier: `edge-${i}` }));
  return { entry: 'a', modules, edges };
}

test('negative controls reject split and merged SCCs', () => {
  const cycle = report(2, [[0, 1], [1, 0]]);
  const separate = report(2, []);
  const merged = oracle(cycle, 'all');
  const split = oracle(separate, 'all');
  assert.doesNotThrow(() => assertOutput(merged, merged, cycle));
  assert.throws(() => assertOutput(merged, split, cycle), assert.AssertionError);
  assert.throws(() => assertOutput(split, merged, separate), assert.AssertionError);
});

test('deterministic graph matrix matches independent reachability oracle', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(scratch, 'condensation-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixtures = [
    report(5, []), report(5, [[0,1],[1,2],[2,3],[3,4]]),
    report(4, [[0,1],[0,2],[1,3],[2,3]]), report(3, [[0,0],[1,1],[0,null]]),
    report(5, [[0,1],[1,0],[2,3],[3,2],[1,2],[0,3]]),
    report(3, [[0,1],[1,2],[2,0,'lazy']]),
  ];
  // Fixed arithmetic enumerates different directed graphs, including lazy edges.
  for (let seed = 0; seed < 32; seed++) {
    const pairs = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
      const v = (seed * 17 + i * 13 + j * 7 + i * j * 3) % 19;
      if (i === 0 && (seed & (1 << j))) pairs.push([i, j, 'lazy']);
      else if (i !== 0 && v < 5) pairs.push([i, j, v === 0 ? 'lazy' : 'eager']);
    }
    fixtures.push(report(5, pairs));
  }
  assert.ok(fixtures.length >= 30);
  for (const [index, fixture] of fixtures.entries()) for (const mode of ['eager', 'all']) {
    const expected = oracle(fixture, mode);
    const reversed = { ...fixture, modules: [...fixture.modules].reverse(), edges: [...fixture.edges].reverse() };
    let original;
    for (const input of [fixture, reversed]) {
      const result = spawnSync(process.execPath, [cli, mode], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TMPDIR: dir },
      });
      const label = `graph ${index}, ${mode}`;
      assert.equal(result.error, undefined, label);
      assert.equal(result.signal, null, label);
      assert.equal(result.status, 0, label);
      assert.equal(result.stderr, '', label);
      assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, label);
      assertOutput(JSON.parse(result.stdout), expected, fixture);
      if (original !== undefined) assert.equal(result.stdout, original, label);
      original = result.stdout;
    }
  }
});
