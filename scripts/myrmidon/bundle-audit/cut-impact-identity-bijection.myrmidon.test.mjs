import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'a', bytes: 2, eager: true },
    { path: 'b', bytes: 3, eager: true },
    { path: 'shared', bytes: 5, eager: true },
    { path: 'tail', bytes: 7, eager: true },
    { path: 'off', bytes: 11, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: './a', kind: 'eager', to: 'a' },
    { from: 'entry', specifier: './b', kind: 'eager', to: 'b' },
    { from: 'a', specifier: './shared', kind: 'eager', to: 'shared' },
    { from: 'b', specifier: './shared', kind: 'eager', to: 'shared' },
    { from: 'a', specifier: './tail', kind: 'eager', to: 'tail' },
    { from: 'entry', specifier: './shortcut', kind: 'lazy', to: 'tail' },
    { from: 'b', specifier: 'external', kind: 'eager', to: null },
  ],
};

// These maps change ordering as well as names; specifiers are deliberately unchanged.
const maps = [
  { entry: 'q', a: 'z', b: 'y', shared: 'x', tail: 'w', off: 'v' },
  { entry: 'src/root.mjs', a: 'z/one.mjs', b: 'y/two.mjs', shared: 'a/shared.mjs', tail: 'b/tail.mjs', off: 'c/off.mjs' },
  { entry: '\u03bb/root', a: '\u96ea/z', b: '\u00e9/y', shared: '\u03b1/shared', tail: '\u00df/tail', off: '\u4e2d/off' },
];
const cases = [
  { entry: 'entry', removed: 'a', lostPaths: ['a', 'tail'], lostBytes: 9 },
  { entry: 'entry', removed: 'entry', lostPaths: ['a', 'b', 'entry', 'shared', 'tail'], lostBytes: 18 },
  { entry: 'entry', removed: 'off', lostPaths: [], lostBytes: 0 },
];

function rename(report, map) {
  return {
    ...report,
    entry: map[report.entry],
    modules: report.modules.map(module => ({ ...module, path: map[module.path] })),
    edges: report.edges.map(edge => ({ ...edge, from: map[edge.from], to: edge.to === null ? null : map[edge.to] })),
  };
}

function run(report, removed) {
  return spawnSync(process.execPath, [cli, removed], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
  });
}

function check(report, selector, expected, inverse) {
  const first = run(report, selector);
  const second = run(report, selector);
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.notEqual(result.stdout, '');
  }
  assert.equal(first.stdout, second.stdout);
  const output = JSON.parse(first.stdout);
  assert.deepEqual(output.lostPaths, [...output.lostPaths].sort());
  if (inverse) {
    output.entry = inverse[output.entry];
    output.removed = inverse[output.removed];
    output.lostPaths = output.lostPaths.map(path => inverse[path]).sort();
  }
  assert.deepEqual(output, expected);
}

test('cut impact is invariant under identity bijections', () => {
  const original = JSON.stringify(fixture);
  for (const expected of cases) check(fixture, expected.removed, expected);
  for (const map of maps) {
    assert.equal(new Set(Object.values(map)).size, fixture.modules.length);
    const inverse = Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
    const renamed = rename(fixture, map);
    for (const expected of cases) check(renamed, map[expected.removed], expected, inverse);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('colliding identities are rejected instead of treated as a bijection', () => {
  const map = { ...maps[0], b: maps[0].a };
  const result = run(rename(fixture, map), map.a);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
