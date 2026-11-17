import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const fixture = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 11, eager: true },
    { path: 'b', bytes: 22, eager: true },
    { path: 'c', bytes: 33, eager: false },
    { path: 'd', bytes: 44, eager: false },
  ],
  edges: [
    { from: 'a', specifier: './b', kind: 'eager', to: 'b' },
    { from: 'a', specifier: 'alias', kind: 'eager', to: 'b' },
    { from: 'a', specifier: './c', kind: 'eager', to: 'c' },
    { from: 'b', specifier: 'self', kind: 'eager', to: 'b' },
    { from: 'b', specifier: 'lazy', kind: 'lazy', to: 'c' },
    { from: 'c', specifier: 'external', kind: 'eager', to: null },
  ],
};

// This oracle is specified independently of the CLI result.
const expected = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 11, targets: ['b', 'c'], fanOut: 2 },
    { path: 'b', bytes: 22, targets: ['b'], fanOut: 1 },
    { path: 'c', bytes: 33, targets: [], fanOut: 0 },
    { path: 'd', bytes: 44, targets: [], fanOut: 0 },
  ],
};
const mappings = [
  { a: 'z', b: 'y', c: 'x', d: 'w' },
  { a: 'pkg/z.js', b: 'nested/y.js', c: 'nested/a.js', d: 'pkg/a.js' },
  { a: '\u03a9', b: '\u00e9', c: '\u03b1', d: '\u4e2d' },
];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });

function rename(report, names) {
  return {
    ...report,
    entry: names[report.entry],
    modules: report.modules.map(mod => ({ ...mod, path: names[mod.path] })),
    edges: report.edges.map(edge => ({ ...edge, from: names[edge.from], to: edge.to === null ? null : names[edge.to] })),
  };
}

function normalize(report, inverse) {
  return {
    ...report,
    entry: inverse[report.entry],
    modules: report.modules.map(mod => ({
      ...mod,
      path: inverse[mod.path],
      targets: mod.targets.map(target => inverse[target]).sort(compare),
    })).sort((a, b) => b.fanOut - a.fanOut || compare(a.path, b.path)),
  };
}

function positive(report, inverse) {
  const first = run(report);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.notEqual(first.stdout, '');
  const second = run(report);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, first.stdout);
  const actual = JSON.parse(first.stdout);
  assert.deepEqual(actual.modules.map(mod => mod.path), [...actual.modules].sort((a, b) => b.fanOut - a.fanOut || compare(a.path, b.path)).map(mod => mod.path));
  for (const mod of actual.modules) assert.deepEqual(mod.targets, [...mod.targets].sort(compare));
  assert.deepEqual(normalize(actual, inverse), expected);
}

test('fan-out is invariant under identity bijections', () => {
  const original = JSON.stringify(fixture);
  positive(fixture, { a: 'a', b: 'b', c: 'c', d: 'd' });
  for (const names of mappings) {
    assert.equal(new Set(Object.values(names)).size, fixture.modules.length);
    const inverse = Object.fromEntries(Object.entries(names).map(([from, to]) => [to, from]));
    positive(rename(fixture, names), inverse);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('colliding identities are rejected instead of treated as a bijection', () => {
  const result = run(rename(fixture, { a: 'z', b: 'y', c: 'y', d: 'w' }));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
