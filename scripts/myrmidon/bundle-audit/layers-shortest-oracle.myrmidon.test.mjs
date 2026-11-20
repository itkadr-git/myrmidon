import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));

function distances(size, edges) {
  const matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => i === j ? 0 : Infinity));
  for (const { from, to, kind } of edges) {
    if (kind === 'eager' && to !== null) matrix[from][to] = Math.min(matrix[from][to], 1);
  }
  // Floyd-Warshall is independent of the production queue traversal.
  for (let k = 0; k < size; k++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i][k] + matrix[k][j]);
      }
    }
  }
  return matrix;
}

function fixture(seed) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const paths = ['entry', 'a', 'b', 'c', 'd', 'e', 'lazy-only', 'isolated'];
  const bytes = paths.map(() => random() % 31);
  bytes[1] = 0;
  const edges = [];
  const add = (from, to, kind = 'eager') => edges.push({ from, to, kind });
  // Diamond, eager shortcut, lazy shortcut, SCC, self-loop and null target.
  add(0, 1); add(0, 2); add(1, 3); add(2, 3); add(3, 4);
  add(0, 4); add(4, 5); add(5, 3); add(3, 3); add(0, 5, 'lazy');
  add(0, 6, 'lazy'); add(2, null);
  for (let i = 0; i < 12; i++) {
    const from = random() % 6, to = random() % 6;
    add(from, to, random() % 3 === 0 ? 'lazy' : 'eager');
  }
  const matrix = distances(paths.length, edges);
  const modules = paths.map((path, i) => ({ path, bytes: bytes[i], eager: Number.isFinite(matrix[0][i]) }));
  const report = {
    entry: paths[0], modules,
    edges: edges.map(({ from, to, kind }, i) => ({ from: paths[from], to: to === null ? null : paths[to], kind, specifier: `edge-${i}` })),
  };
  const layers = [], unreachable = [];
  for (const i of paths.map((_, i) => i).sort((a, b) => paths[a] < paths[b] ? -1 : paths[a] > paths[b] ? 1 : 0)) {
    const depth = matrix[0][i];
    if (!Number.isFinite(depth)) { unreachable.push(paths[i]); continue; }
    if (!layers[depth]) layers[depth] = { depth, paths: [], bytes: 0 };
    layers[depth].paths.push(paths[i]);
    layers[depth].bytes += bytes[i];
  }
  return { report, expected: { entry: paths[0], layers, unreachable } };
}

function check(report, expected, label) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, label);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.equal(result.stderr, '', label);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`, label);
}

test('30 seeded graphs match independent all-pairs shortest eager distances', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { report, expected } = fixture(seed);
    check(report, expected, `seed ${seed}`);
    check(report, expected, `seed ${seed} repeat`);
    check({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, expected, `seed ${seed} reversed`);
  }
});
