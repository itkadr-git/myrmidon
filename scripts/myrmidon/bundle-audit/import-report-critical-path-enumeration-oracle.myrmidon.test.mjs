import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const vertices = ['a', 'b', 'c', 'd'];
const pairs = vertices.flatMap((from, i) => vertices.slice(i + 1).map(to => [from, to]));
const edge = (from, to, kind = 'eager', specifier = String(to)) => ({ from, to, kind, specifier });

function oracle(report) {
  const weights = new Map(report.modules.map(({ path, bytes }) => [path, bytes]));
  const paths = [];
  function visit(path, bytes) {
    paths.push({ paths: path, bytes });
    for (const e of report.edges) {
      if (e.from === path[path.length - 1] && e.kind === 'eager' && e.to !== null) {
        visit([...path, e.to], bytes + weights.get(e.to));
      }
    }
  }
  visit([report.entry], weights.get(report.entry));
  paths.sort((a, b) => {
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    for (let i = 0; i < Math.min(a.paths.length, b.paths.length); i++) {
      if (a.paths[i] !== b.paths[i]) return a.paths[i] < b.paths[i] ? -1 : 1;
    }
    return a.paths.length - b.paths.length;
  });
  return { entry: report.entry, ...paths[0] };
}

function harness(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'critical-path-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return report => {
    const result = spawnSync(process.execPath, [cli], {
      input: JSON.stringify(report), encoding: 'utf8', cwd: dir,
      env: { ...process.env, HOME: dir, TMPDIR: dir }, shell: false,
      timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(oracle(report)) + '\n');
  };
}

test('enumerates all paths in all four-vertex DAGs for deterministic weights', t => {
  const run = harness(t);
  const weightSets = [[0, 0, 0, 0], [1, 1, 1, 1], [7, 1, 7, 0], [0, 7, 1, 7], [1, 0, 0, 7]];
  for (let mask = 0; mask < 64; mask++) {
    for (const weights of weightSets) {
      const modules = vertices.map((path, i) => ({ path, bytes: weights[i], eager: true }));
      const edges = pairs.filter((_, i) => mask & (1 << i)).map(([from, to]) => edge(from, to));
      run({ entry: 'a', modules, edges });
    }
  }
});

test('weighted diamond, aliases, lazy and null edges, and disconnected nodes', t => {
  const run = harness(t);
  const report = {
    entry: 'a',
    modules: [
      { path: 'a', bytes: 0, eager: true }, { path: 'b', bytes: 1, eager: true },
      { path: 'c', bytes: 7, eager: true }, { path: 'd', bytes: 1, eager: true },
      { path: 'x', bytes: 99, eager: false },
    ],
    edges: [edge('a', 'b'), edge('b', 'd'), edge('a', 'c'), edge('c', 'd'),
      edge('a', 'c', 'eager', 'alias-c'), edge('a', 'x', 'lazy'), edge('a', null), edge('x', 'x')],
  };
  assert.deepEqual(oracle(report), { entry: 'a', paths: ['a', 'c', 'd'], bytes: 8 });
  run(report);
  run({ ...report, modules: report.modules.filter(m => m.path !== 'x'), edges: report.edges.filter(e => e.from !== 'x' && e.to !== 'x') });
});
