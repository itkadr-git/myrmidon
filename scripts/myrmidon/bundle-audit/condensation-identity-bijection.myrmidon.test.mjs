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

// A transitive-closure model computes mutual reachability without copying the CLI traversal.
function model(report, mode) {
  const paths = report.modules.map(m => m.path).sort(cmp);
  const reach = paths.map((_, i) => paths.map((__, j) => i === j));
  for (const e of report.edges) {
    if (e.to !== null && (mode === 'all' || e.kind === 'eager')) reach[paths.indexOf(e.from)][paths.indexOf(e.to)] = true;
  }
  for (let k = 0; k < paths.length; k++) for (let i = 0; i < paths.length; i++) for (let j = 0; j < paths.length; j++) {
    reach[i][j] ||= reach[i][k] && reach[k][j];
  }
  const groups = [];
  for (let i = 0; i < paths.length; i++) {
    if (!groups.some(g => g.includes(paths[i]))) groups.push(paths.filter((_, j) => reach[i][j] && reach[j][i]));
  }
  const owner = path => groups.find(g => g.includes(path))[0];
  const components = groups.map(paths => ({ id: paths[0], paths, bytes: paths.reduce((n, path) => n + report.modules.find(m => m.path === path).bytes, 0) }));
  const edges = [];
  for (const e of report.edges) {
    if (e.to === null || (mode === 'eager' && e.kind !== 'eager')) continue;
    const from = owner(e.from), to = owner(e.to);
    if (from !== to && !edges.some(e => e.from === from && e.to === to)) edges.push({ from, to });
  }
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { entry: report.entry, components, edges };
}
function assertExact(result, report, mode) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(model(report, mode))}\n`);
}
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, to, kind, specifier) => ({ from, to, kind, specifier });
const mixed = [
  fixture,
  { entry: 'a', modules: [m('a', 2, true), m('b', 3, false), m('c', 5, true)], edges: [e('a', 'b', 'eager', 'ab'), e('b', 'a', 'lazy', 'ba'), e('b', 'c', 'eager', 'bc'), e('c', null, 'lazy', 'external')] },
  { entry: 'a', modules: [m('a', 0, false), m('b', 6, true), m('c', 4, true), m('d', 1, false)], edges: [e('a', 'b', 'lazy', 'ab'), e('b', 'c', 'eager', 'bc'), e('c', 'a', 'eager', 'ca'), e('d', 'c', 'eager', 'dc')] },
  { entry: 'a', modules: [m('a', 1, true), m('b', 9, false), m('c', 4, true), m('d', 2, false)], edges: [e('a', 'b', 'eager', 'ab'), e('b', 'a', 'eager', 'ba'), e('c', 'd', 'lazy', 'cd'), e('d', 'c', 'eager', 'dc'), e('b', 'c', 'eager', 'bc'), e('a', 'd', 'eager', 'ad')] },
];
const literalNames = [
  ['z space', '../alpha', '\u96ea!', 'punct:?#', 'isolated'],
  ['../first', 'middle space', 'z\u03bb', '!last', 'other'],
];
test('mixed graphs match an independent mutual-reachability model after bijections', () => {
  for (const original of mixed) for (const mode of ['eager', 'all']) {
    const variants = literalNames.map(names => {
      const map = Object.fromEntries(original.modules.map((m, i) => [m.path, names[i]]));
      assert.equal(new Set(Object.values(map)).size, original.modules.length);
      return rename(original, map);
    });
    for (const report of [original, ...variants]) assertExact(run(report, mode), report, mode);
  }
  const reordered = rename(fixture, Object.fromEntries(fixture.modules.map((m, i) => [m.path, literalNames[0][i]])));
  assert.equal(model(reordered, 'eager').components.find(c => c.paths.includes('z space')).id, '../alpha');
});
test('exact assertion rejects corrupted outputs', () => {
  const result = run(fixture, 'all');
  assertExact(result, fixture, 'all');
  for (const stdout of ['{}\n', JSON.stringify({ ...model(fixture, 'all'), edges: [] }) + '\n']) {
    assert.throws(() => assertExact({ ...result, stdout }, fixture, 'all'));
  }
});

test('colliding renames are rejected by the CLI', () => {
  const sentinel = 'SENTINEL_private_identity';
  const report = rename(fixture, { ...maps[0], a: sentinel, b: sentinel });
  for (const mode of ['eager', 'all']) {
    const result = run(report, mode);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
    assert.ok(!result.stderr.includes(sentinel));
  }
});
