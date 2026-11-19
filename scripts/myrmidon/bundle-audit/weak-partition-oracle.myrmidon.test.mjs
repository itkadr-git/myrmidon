import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const modules = [
  { path: 'a', bytes: 2, eager: true },
  { path: 'b', bytes: 5, eager: false },
  { path: 'c', bytes: 11, eager: false },
];
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `${from}-${to}` });

// Floyd-Warshall over a symmetric adjacency matrix, independent of the CLI traversal.
function oracle(report, mode) {
  const vertices = [...report.modules].sort((a, b) => a.path.localeCompare(b.path));
  const reach = vertices.map((_, i) => vertices.map((_, j) => i === j));
  for (const { from, to, kind } of report.edges) {
    if (to === null || (mode === 'eager' && kind !== 'eager')) continue;
    const i = vertices.findIndex(x => x.path === from);
    const j = vertices.findIndex(x => x.path === to);
    reach[i][j] = reach[j][i] = true;
  }
  for (let k = 0; k < vertices.length; k++)
    for (let i = 0; i < vertices.length; i++)
      for (let j = 0; j < vertices.length; j++)
        reach[i][j] ||= reach[i][k] && reach[k][j];
  const components = vertices.flatMap((vertex, i) => {
    if (reach[i].slice(0, i).some(Boolean)) return [];
    const members = vertices.filter((_, j) => reach[i][j]);
    return [{ id: vertex.path, paths: members.map(x => x.path), bytes: members.reduce((sum, x) => sum + x.bytes, 0) }];
  });
  return { entry: report.entry, components };
}

function run(report, mode, executable = cli) {
  const result = spawnSync(process.execPath, [executable, mode], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function check(report, mode, executable = cli) {
  const actual = run(report, mode, executable);
  assert.deepEqual(actual, oracle(report, mode));
  assert.deepEqual(actual.components.flatMap(component => component.paths).sort(), report.modules.map(x => x.path).sort());
}

test('all 64 loop-free directed eager graphs match matrix closure in both modes', () => {
  const pairs = modules.flatMap(a => modules.filter(b => a !== b).map(b => [a.path, b.path]));
  for (let mask = 0; mask < 2 ** pairs.length; mask++) {
    const report = { entry: 'a', modules, edges: pairs.filter((_, i) => mask & (1 << i)).map(([from, to]) => edge(from, to)) };
    for (const mode of ['eager', 'all']) {
      try { check(report, mode); } catch (error) { error.message = `mask=${mask}, mode=${mode}: ${error.message}`; throw error; }
    }
  }
});

test('lazy bridge is included only in all and disconnected entry does not limit analysis', () => {
  const report = { entry: 'a', modules, edges: [edge('b', 'c', 'lazy')] };
  check(report, 'eager');
  check(report, 'all');
  assert.deepEqual(run(report, 'eager').components, [
    { id: 'a', paths: ['a'], bytes: 2 }, { id: 'b', paths: ['b'], bytes: 5 }, { id: 'c', paths: ['c'], bytes: 11 },
  ]);
  assert.deepEqual(run(report, 'all').components, [
    { id: 'a', paths: ['a'], bytes: 2 }, { id: 'b', paths: ['b', 'c'], bytes: 16 },
  ]);
});

test('negative control detects missing reverse adjacency', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(scratch, 'weak-oracle-'));
  try {
    const source = readFileSync(cli, 'utf8');
    const line = '      neighbors.get(edge.to).push(edge.from);';
    assert.equal(source.split(line).length, 2, 'mutation must match exactly once');
    const mutant = join(dir, 'mutant.mjs');
    writeFileSync(mutant, source.replace(line, ''));
    const report = { entry: 'a', modules, edges: [edge('b', 'a')] };
    assert.throws(() => check(report, 'eager', mutant), { code: 'ERR_ASSERTION' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
