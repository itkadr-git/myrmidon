import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `${kind}:${to}` });

// Floyd-Warshall computes reachability without following production's DFS.
function reachable(report, removed) {
  const names = report.modules.map(m => m.path);
  const matrix = names.map((a, i) => names.map((b, j) => a !== removed && b !== removed && i === j));
  for (const { from, to, kind } of report.edges) {
    if (kind === 'eager' && to !== null && from !== removed && to !== removed) {
      matrix[names.indexOf(from)][names.indexOf(to)] = true;
    }
  }
  for (let k = 0; k < names.length; k++)
    for (let i = 0; i < names.length; i++)
      for (let j = 0; j < names.length; j++)
        matrix[i][j] ||= matrix[i][k] && matrix[k][j];
  return matrix[names.indexOf(report.entry)];
}

function expected(report, removed) {
  const before = reachable(report, null);
  const after = reachable(report, removed);
  const lost = report.modules.filter((_, i) => before[i] && !after[i]);
  return { entry: report.entry, removed, lostPaths: lost.map(m => m.path).sort(), lostBytes: lost.reduce((n, m) => n + m.bytes, 0) };
}

function check(report, label) {
  for (const { path } of report.modules) {
    const result = spawnSync(process.execPath, [cli, path], { input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${label}/${path}: ${result.stderr}`);
    assert.equal(result.stderr, '', `${label}/${path}`);
    assert.equal(result.stdout, `${JSON.stringify(expected(report, path))}\n`, `${label}/${path}`);
  }
}

function fixture(edges) {
  return { entry: 'entry', modules: ['entry', 'a', 'b', 'end', 'isolated'].map((path, i) => ({ path, bytes: i * 3 + 1, eager: i % 2 === 0 })), edges };
}

test('hand-written chain, diamond, cycle with exit, isolated, lazy and null edges', () => {
  const cases = [
    fixture([edge('entry', 'a'), edge('a', 'b'), edge('b', 'end'), edge('entry', 'end', 'lazy'), edge('a', null)]),
    fixture([edge('entry', 'a'), edge('entry', 'b'), edge('a', 'end'), edge('b', 'end')]),
    fixture([edge('entry', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'end')]),
  ];
  assert.deepEqual(expected(cases[0], 'a'), { entry: 'entry', removed: 'a', lostPaths: ['a', 'b', 'end'], lostBytes: 21 });
  assert.deepEqual(expected(cases[1], 'a'), { entry: 'entry', removed: 'a', lostPaths: ['a'], lostBytes: 4 });
  assert.deepEqual(expected(cases[2], 'isolated'), { entry: 'entry', removed: 'isolated', lostPaths: [], lostBytes: 0 });
  cases.forEach((report, i) => check(report, `hand-${i}`));
});

test('fixed seed graph matrix checks every removed vertex', () => {
  let state = 0x14360;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let graph = 0; graph < 24; graph++) {
    const names = ['entry', 'a', 'b', 'end', 'isolated'];
    const edges = [];
    for (const from of names) for (const to of names) {
      const value = next();
      if ((value >>> 24) < 65) edges.push(edge(from, to, (value & 16) ? 'eager' : 'lazy'));
    }
    edges.push(edge(names[graph % names.length], null));
    check(fixture(edges), `seed-0x14360-graph-${graph}`);
  }
});
