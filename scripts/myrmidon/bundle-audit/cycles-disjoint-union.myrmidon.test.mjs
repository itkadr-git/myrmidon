import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const moduleFor = path => ({ path, bytes: 0, eager: false });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const report = (entry, paths, edges) => ({ entry, modules: paths.map(moduleFor), edges });
const invoke = value => spawnSync(process.execPath, [cli, '-'], {
  input: JSON.stringify(value), encoding: 'utf8', timeout: 10000,
});
const check = (value, expected) => {
  const before = JSON.stringify(value);
  const result = invoke(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.equal(JSON.stringify(value), before);
};

test('disjoint unions preserve all cyclic components for either entry', () => {
  const cases = [
    {
      a: report('a', ['a', 'b'], [edge('a', 'b'), edge('b', 'a')]),
      b: report('x', ['x'], [edge('x', 'x')]),
      ea: { entry: 'a', eagerCycles: [['a', 'b']], allCycles: [['a', 'b']] },
      eb: { entry: 'x', eagerCycles: [['x']], allCycles: [['x']] },
      eu: { entry: 'a', eagerCycles: [['a', 'b'], ['x']], allCycles: [['a', 'b'], ['x']] },
      ev: { entry: 'x', eagerCycles: [['a', 'b'], ['x']], allCycles: [['a', 'b'], ['x']] },
    },
    {
      a: report('m', ['m', 'n'], [edge('m', 'n'), edge('n', 'm')]),
      b: report('B', ['B', 'C'], [edge('B', 'C'), edge('C', 'B', 'lazy')]),
      ea: { entry: 'm', eagerCycles: [['m', 'n']], allCycles: [['m', 'n']] },
      eb: { entry: 'B', eagerCycles: [], allCycles: [['B', 'C']] },
      eu: { entry: 'm', eagerCycles: [['m', 'n']], allCycles: [['B', 'C'], ['m', 'n']] },
      ev: { entry: 'B', eagerCycles: [['m', 'n']], allCycles: [['B', 'C'], ['m', 'n']] },
    },
    {
      a: report('d', ['d', 'e', 'f'], [edge('d', 'e'), edge('d', 'f'), edge('e', 'f')]),
      b: report('p', ['p', 'q'], [edge('p', 'q')]),
      ea: { entry: 'd', eagerCycles: [], allCycles: [] },
      eb: { entry: 'p', eagerCycles: [], allCycles: [] },
      eu: { entry: 'd', eagerCycles: [], allCycles: [] },
      ev: { entry: 'p', eagerCycles: [], allCycles: [] },
    },
  ];
  for (const { a, b, ea, eb, eu, ev } of cases) {
    const before = JSON.stringify([a, b]);
    const union = { entry: a.entry, modules: [...a.modules, ...b.modules], edges: [...a.edges, ...b.edges] };
    check(a, ea); check(b, eb); check(union, eu); check(union, eu);
    check({ ...union, entry: b.entry }, ev);
    check({ ...union, modules: [...union.modules].reverse(), edges: [...union.edges].reverse() }, eu);
    check({ ...a, modules: [...a.modules].reverse(), edges: [...a.edges].reverse() }, ea);
    check({ ...b, modules: [...b.modules].reverse(), edges: [...b.edges].reverse() }, eb);
    assert.equal(JSON.stringify([a, b]), before);
  }
});

test('rejects an absent endpoint without exposing input', () => {
  const value = report('a', ['a'], [edge('a', 'secret-missing-endpoint')]);
  const before = JSON.stringify(value);
  const result = invoke(value);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FAIL: reference\n');
  assert.equal(JSON.stringify(value), before);
});
