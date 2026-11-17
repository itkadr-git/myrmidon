import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-layers.mjs', import.meta.url).pathname;
const mod = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unknown') => ({ from, to, specifier, kind });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });

function check(report, expected) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
}

function contract(before, removed, unreachable, baseline, expected) {
  const original = structuredClone(before);
  const after = {
    ...before,
    modules: before.modules.map(m => ({ ...m, eager: !unreachable.includes(m.path) })),
    edges: before.edges.filter((_, index) => !removed.includes(index)).map(e => ({ ...e })),
  };
  check(before, baseline);
  check(after, expected);
  assert.deepEqual(before, original);
  const restored = { ...after, modules: before.modules.map(m => ({ ...m })), edges: before.edges.map(e => ({ ...e })) };
  check(restored, baseline);
}

test('removing a shortcut moves c from depth one to depth three', () => {
  const report = { entry: 'e', modules: [mod('e', 1), mod('a', 2), mod('b', 3), mod('c', 4)], edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'c'), edge('e', 'c')] };
  contract(report, [3], [],
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'c'], bytes: 6 }, { depth: 2, paths: ['b'], bytes: 3 }], unreachable: [] },
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }, { depth: 2, paths: ['b'], bytes: 3 }, { depth: 3, paths: ['c'], bytes: 4 }], unreachable: [] });
});

test('removing one diamond path keeps the shared vertex at its remaining shortest depth', () => {
  const report = { entry: 'e', modules: [mod('e', 1), mod('a', 2), mod('b', 3), mod('c', 4)], edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 'c'), edge('b', 'c')] };
  contract(report, [2], [],
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'b'], bytes: 5 }, { depth: 2, paths: ['c'], bytes: 4 }], unreachable: [] },
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'b'], bytes: 5 }, { depth: 2, paths: ['c'], bytes: 4 }], unreachable: [] });
});

test('removing the only bridge preserves modules but makes the chain unreachable', () => {
  const report = { entry: 'e', modules: [mod('e', 1), mod('x', 7), mod('y', 9), mod('z', 3, false)], edges: [edge('e', 'x'), edge('x', 'y')] };
  contract(report, [0], ['x', 'y', 'z'],
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['x'], bytes: 7 }, { depth: 2, paths: ['y'], bytes: 9 }], unreachable: ['z'] },
    { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }], unreachable: ['x', 'y', 'z'] });
});

test('removing lazy, unknown or one alias edge leaves layers unchanged', () => {
  const report = { entry: 'e', modules: [mod('e', 1), mod('a', 2), mod('z', 3, false)], edges: [edge('e', 'a'), edge('e', 'a', 'eager', 'alias-a'), edge('e', 'z', 'lazy'), edge('e', null)] };
  const expected = { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }], unreachable: ['z'] };
  for (const index of [1, 2, 3]) contract(report, [index], ['z'], expected, expected);
});

test('missing endpoint fails with graph only and does not leak input paths', () => {
  const result = run({ entry: 'secret-entry', modules: [mod('secret-entry', 1)], edges: [edge('secret-entry', 'secret-missing')] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
