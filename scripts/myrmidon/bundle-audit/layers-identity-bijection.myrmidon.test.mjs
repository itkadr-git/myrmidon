import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});

const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 11, eager: true },
    { path: 'a', bytes: 2, eager: true },
    { path: 'b', bytes: 3, eager: true },
    { path: 'join', bytes: 5, eager: true },
    { path: 'end', bytes: 7, eager: true },
    { path: 'off', bytes: 13, eager: false },
    { path: 'off-child', bytes: 17, eager: false },
  ],
  edges: [
    { from: 'entry', to: 'a', kind: 'eager', specifier: './left' },
    { from: 'entry', to: 'b', kind: 'eager', specifier: './right' },
    { from: 'a', to: 'join', kind: 'eager', specifier: './join-a' },
    { from: 'b', to: 'join', kind: 'eager', specifier: './join-b' },
    { from: 'join', to: 'a', kind: 'eager', specifier: './cycle' },
    { from: 'join', to: 'end', kind: 'eager', specifier: './end' },
    { from: 'entry', to: 'end', kind: 'lazy', specifier: './shortcut' },
    { from: 'entry', to: null, kind: 'lazy', specifier: 'external' },
    { from: 'off', to: 'off-child', kind: 'eager', specifier: './child' },
  ],
};

// Hand-calculated shortest eager paths: entry -> {a,b} -> join -> end.
const expected = {
  entry: 'entry',
  layers: [
    { depth: 0, paths: ['entry'], bytes: 11 },
    { depth: 1, paths: ['a', 'b'], bytes: 5 },
    { depth: 2, paths: ['join'], bytes: 5 },
    { depth: 3, paths: ['end'], bytes: 7 },
  ],
  unreachable: ['off', 'off-child'],
};

const identities = ['entry', 'a', 'b', 'join', 'end', 'off', 'off-child'];
const mappings = [
  ['root', 'z', 'y', 'm', 'n', 'q', 'p'],
  ['tree/root.mjs', 'tree/z/a.mjs', 'tree/a/b.mjs', 'lib/join.mjs', 'lib/end.mjs', 'unused/z.mjs', 'unused/a.mjs'],
  ['\u03a9/root', '\u00e9', '\u03b1', '\u4e2d', '\u00f1', '\u03c9', '\u03b2'],
];

function rename(report, map) {
  const translate = value => value === null ? null : map.get(value);
  return {
    ...report,
    entry: translate(report.entry),
    modules: report.modules.map(mod => ({ ...mod, path: translate(mod.path) })),
    edges: report.edges.map(edge => ({ ...edge, from: translate(edge.from), to: translate(edge.to) })),
  };
}

function check(report, inverse) {
  const first = run(report);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.notEqual(first.stdout, '');
  const repeated = run(report);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.stderr, '');
  assert.equal(repeated.stdout, first.stdout);
  const actual = JSON.parse(first.stdout);
  if (inverse) {
    actual.entry = inverse.get(actual.entry);
    for (const layer of actual.layers) layer.paths = layer.paths.map(path => inverse.get(path)).sort();
    actual.unreachable = actual.unreachable.map(path => inverse.get(path)).sort();
  }
  assert.deepEqual(actual, expected);
}

test('bijective identity changes preserve eager layers and unreachable modules', () => {
  const original = JSON.stringify(fixture);
  check(fixture);
  for (const names of mappings) {
    assert.equal(new Set(names).size, identities.length);
    const forward = new Map(identities.map((name, i) => [name, names[i]]));
    const inverse = new Map([...forward].map(([from, to]) => [to, from]));
    check(rename(fixture, forward), inverse);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('colliding identities are rejected, not treated as a bijection', () => {
  const names = [...mappings[0]];
  names[2] = names[1];
  const result = run(rename(fixture, new Map(identities.map((name, i) => [name, names[i]]))));
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
