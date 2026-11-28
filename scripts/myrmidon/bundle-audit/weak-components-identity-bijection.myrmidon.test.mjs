import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const fixture = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: 3, eager: true },
    { path: 'c', bytes: 5, eager: false }, { path: 'd', bytes: 7, eager: false },
    { path: 'isolated', bytes: 11, eager: false },
  ],
  edges: [
    { from: 'b', specifier: './a', kind: 'eager', to: 'a' },
    { from: 'd', specifier: './c', kind: 'eager', to: 'c' },
    { from: 'b', specifier: './bridge', kind: 'lazy', to: 'c' },
    { from: 'a', specifier: 'external', kind: 'eager', to: null },
  ],
};

// These partitions and totals are specified independently of the CLI traversal.
const expected = {
  eager: [{ paths: ['a', 'b'], bytes: 5 }, { paths: ['c', 'd'], bytes: 12 }, { paths: ['isolated'], bytes: 11 }],
  all: [{ paths: ['a', 'b', 'c', 'd'], bytes: 17 }, { paths: ['isolated'], bytes: 11 }],
};
const maps = [
  { a: 'z', b: 'y', c: 'x', d: 'w', isolated: 'v' },
  { a: 'nested/z.js', b: 'nested/y.js', c: 'other/x.js', d: 'other/w.js', isolated: 'deep/v.js' },
  { a: '\u03c9', b: '\u03b2', c: '\u96ea', d: '\u03b1', isolated: '\u00e9' },
];
const rename = (report, map) => ({
  ...report,
  entry: map[report.entry],
  modules: report.modules.map(mod => ({ ...mod, path: map[mod.path] })),
  edges: report.edges.map(edge => ({ ...edge, from: map[edge.from], to: edge.to === null ? null : map[edge.to] })),
});
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});
function oracle(mode, map) {
  const components = expected[mode].map(component => {
    const paths = component.paths.map(path => map[path]).sort();
    return { id: paths[0], paths, bytes: component.bytes };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { entry: map.a, components };
}
function check(report, mode, map) {
  const result = run(report, mode);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), oracle(mode, map));
  const repeat = run(report, mode);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stderr, '');
  assert.equal(repeat.stdout, result.stdout);
  return JSON.parse(result.stdout);
}

test('weak components preserve their partition and bytes under identity bijections', () => {
  const original = JSON.stringify(fixture);
  const identity = Object.fromEntries(fixture.modules.map(mod => [mod.path, mod.path]));
  for (const mode of ['eager', 'all']) {
    const baseline = check(fixture, mode, identity);
    for (const map of maps) {
      assert.equal(new Set(Object.values(map)).size, fixture.modules.length);
      const transformed = rename(fixture, map);
      const result = check(transformed, mode, map);
      const inverse = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
      const partition = value => value.components.map(({ paths, bytes }) => ({
        paths: paths.map(path => inverse[path] ?? path).sort(), bytes,
      })).sort((a, b) => a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0);
      assert.deepEqual(partition(result), partition(baseline));
    }
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('a collision is rejected rather than treated as a bijection', () => {
  const map = { ...maps[0], b: maps[0].a };
  const result = run(rename(fixture, map), 'all');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
