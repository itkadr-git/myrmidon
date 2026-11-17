import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const fixture = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: 3, eager: true },
    { path: 'c', bytes: 5, eager: true }, { path: 'd', bytes: 7, eager: false },
    { path: 'x', bytes: 11, eager: false },
  ],
  edges: [
    { from: 'a', to: 'b', kind: 'eager', specifier: './b' },
    { from: 'b', to: 'a', kind: 'eager', specifier: './a' },
    { from: 'b', to: 'c', kind: 'eager', specifier: './c' },
    { from: 'b', to: 'c', kind: 'eager', specifier: 'alias-c' },
    { from: 'a', to: 'c', kind: 'eager', specifier: 'other-c' },
    { from: 'c', to: 'd', kind: 'eager', specifier: './d' },
    { from: 'd', to: 'c', kind: 'lazy', specifier: './c' },
    { from: 'x', to: null, kind: 'lazy', specifier: 'external' },
  ],
};
const maps = [
  { a: 'z', b: 'y', c: 'w', d: 'v', x: 'u' },
  { a: 'nested/z.mjs', b: 'nested/a.mjs', c: 'pkg/y.mjs', d: 'pkg/b.mjs', x: 'isolated/x.mjs' },
  { a: '\u03c9', b: '\u03b1', c: '\u96ea/z', d: '\u96ea/a', x: '\u00e9' },
];
const expected = {
  eager: { entry: 'a', components: [
    { id: 'a', paths: ['a', 'b'], bytes: 5 }, { id: 'c', paths: ['c'], bytes: 5 },
    { id: 'd', paths: ['d'], bytes: 7 }, { id: 'x', paths: ['x'], bytes: 11 },
  ], edges: [{ from: 'a', to: 'c' }, { from: 'c', to: 'd' }] },
  all: { entry: 'a', components: [
    { id: 'a', paths: ['a', 'b'], bytes: 5 }, { id: 'c', paths: ['c', 'd'], bytes: 12 },
    { id: 'x', paths: ['x'], bytes: 11 },
  ], edges: [{ from: 'a', to: 'c' }] },
};
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});
function rename(report, map) {
  return { ...report, entry: map[report.entry],
    modules: report.modules.map(m => ({ ...m, path: map[m.path] })),
    edges: report.edges.map(e => ({ ...e, from: map[e.from], to: e.to === null ? null : map[e.to] })),
  };
}
function normalize(output, inverse) {
  const ids = new Map();
  const components = output.components.map(component => {
    assert.deepEqual(component.paths, [...component.paths].sort(cmp));
    assert.equal(component.id, component.paths[0]);
    const paths = component.paths.map(path => {
      assert.ok(Object.hasOwn(inverse, path), `unknown identity: ${path}`);
      return inverse[path];
    }).sort(cmp);
    ids.set(component.id, paths[0]);
    return { ...component, id: paths[0], paths };
  });
  assert.deepEqual(output.components.map(c => c.id), output.components.map(c => c.id).sort(cmp));
  assert.deepEqual(output.edges, [...output.edges].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)));
  const edges = output.edges.map(edge => {
    assert.ok(ids.has(edge.from) && ids.has(edge.to));
    return { ...edge, from: ids.get(edge.from), to: ids.get(edge.to) };
  }).sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  assert.ok(Object.hasOwn(inverse, output.entry));
  return { ...output, entry: inverse[output.entry], components: components.sort((a, b) => cmp(a.id, b.id)), edges };
}

test('identity bijections preserve the complete eager and all condensation reports', () => {
  const original = JSON.stringify(fixture);
  const identity = Object.fromEntries(fixture.modules.map(m => [m.path, m.path]));
  for (const map of [identity, ...maps]) {
    assert.equal(new Set(Object.values(map)).size, fixture.modules.length);
    const inverse = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
    const report = rename(fixture, map);
    for (const mode of ['eager', 'all']) {
      const result = run(report, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.notEqual(result.stdout, '');
      const repeat = run(report, mode);
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.equal(repeat.stderr, '');
      assert.equal(repeat.stdout, result.stdout);
      assert.deepEqual(normalize(JSON.parse(result.stdout), inverse), expected[mode]);
    }
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('colliding renames are rejected by the CLI', () => {
  const report = rename(fixture, { ...maps[0], b: maps[0].a });
  for (const mode of ['eager', 'all']) {
    const result = run(report, mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
