import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 2, eager: true },
    { path: 'a', bytes: 3, eager: true },
    { path: 'b', bytes: 4, eager: false },
    { path: 'shared', bytes: 7, eager: true },
    { path: 'zero', bytes: 0, eager: false },
    { path: 'loop', bytes: 11, eager: true },
    { path: 'disconnected', bytes: 19, eager: false },
  ],
  edges: [
    { from: 'entry', to: 'a', kind: 'eager', specifier: './a' },
    { from: 'entry', to: 'b', kind: 'eager', specifier: './b' },
    { from: 'entry', to: 'zero', kind: 'eager', specifier: './zero' },
    { from: 'entry', to: 'loop', kind: 'eager', specifier: './loop' },
    { from: 'a', to: 'shared', kind: 'eager', specifier: './shared' },
    { from: 'b', to: 'shared', kind: 'eager', specifier: './shared' },
    { from: 'loop', to: 'loop', kind: 'eager', specifier: './self' },
    { from: 'zero', to: null, kind: 'eager', specifier: 'external' },
    { from: 'zero', to: 'disconnected', kind: 'lazy', specifier: './lazy' },
  ],
};
const expected = { entry: 'entry', sinks: [{ path: 'shared', bytes: 7 }, { path: 'zero', bytes: 0 }], sinkBytes: 7 };
const names = fixture.modules.map(module => module.path);
const mappings = [
  ['root', 'z', 'y', 'x', 'w', 'v', 'u'],
  ['pkg/root', 'pkg/z/a', 'pkg/y/b', 'pkg/x/shared', 'pkg/w/zero', 'pkg/v/loop', 'pkg/u/disconnected'],
  ['\u03c1', '\u03c9', '\u03c8', '\u03c7', '\u03c6', '\u03c5', '\u03c4'],
];

function rename(report, mapping) {
  const identity = value => value === null ? null : mapping.get(value);
  return {
    ...report,
    entry: identity(report.entry),
    modules: report.modules.map(module => ({ ...module, path: identity(module.path) })),
    edges: report.edges.map(edge => ({ ...edge, from: identity(edge.from), to: identity(edge.to) })),
  };
}

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
}

function verify(report, inverse) {
  const first = run(report);
  const second = run(report);
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const actual = JSON.parse(result.stdout);
    actual.entry = inverse.get(actual.entry);
    for (const sink of actual.sinks) sink.path = inverse.get(sink.path);
    actual.sinks.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.deepEqual(actual, expected);
  }
  assert.equal(first.stdout, second.stdout);
}

test('sink identities survive fixed bijections without changing graph semantics', () => {
  const original = JSON.stringify(fixture);
  verify(fixture, new Map(names.map(name => [name, name])));
  for (const renamed of mappings) {
    assert.equal(new Set(renamed).size, names.length);
    const forward = new Map(names.map((name, i) => [name, renamed[i]]));
    const inverse = new Map(names.map((name, i) => [renamed[i], name]));
    verify(rename(fixture, forward), inverse);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('colliding module identities are rejected', () => {
  const mapping = new Map(names.map(name => [name, name === 'b' ? 'a' : name]));
  const result = run(rename(fixture, mapping));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
