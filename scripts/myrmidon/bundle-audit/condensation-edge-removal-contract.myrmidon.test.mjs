import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });
const component = (id, paths, bytes) => ({ id, paths, bytes });
const output = (components, edges) => ({ entry: 'a', components, edges });
const link = (from, to) => ({ from, to });
const modules = flags => [
  { path: 'a', bytes: 2, eager: flags[0] },
  { path: 'b', bytes: 3, eager: flags[1] },
  { path: 'c', bytes: 5, eager: flags[2] },
  { path: 'd', bytes: 7, eager: flags[3] },
];
const singles = [component('a', ['a'], 2), component('b', ['b'], 3), component('c', ['c'], 5), component('d', ['d'], 7)];
const matrices = [
  {
    name: 'break a three-node SCC into a DAG',
    edges: [edge('a','b'), edge('b','c'), edge('c','a'), edge('a','d','lazy'), edge('d','a','lazy'), edge('a',null)],
    removed: 0, beforeFlags: [true,true,true,false], afterFlags: [true,false,false,false],
    before: {
      eager: output([component('a',['a','b','c'],10), component('d',['d'],7)], []),
      all: output([component('a',['a','b','c','d'],17)], []),
    },
    after: {
      eager: output(singles, [link('b','c'),link('c','a')]),
      all: output([component('a',['a','d'],9),component('b',['b'],3),component('c',['c'],5)], [link('b','c'),link('c','a')]),
    },
  },
  {
    name: 'break one of two cycles while retaining an alias',
    edges: [edge('a','b'),edge('a','b','eager','alias-b'),edge('b','a'),edge('b','c'),edge('c','b'),edge('c','d','lazy'),edge('d','c','lazy')],
    removed: 4, beforeFlags: [true,true,true,false], afterFlags: [true,true,true,false],
    before: {
      eager: output([component('a',['a','b','c'],10),component('d',['d'],7)], []),
      all: output([component('a',['a','b','c','d'],17)], []),
    },
    after: {
      eager: output([component('a',['a','b'],5),component('c',['c'],5),component('d',['d'],7)], [link('a','c')]),
      all: output([component('a',['a','b'],5),component('c',['c','d'],12)], [link('a','c')]),
    },
  },
  {
    name: 'remove a self-loop without losing its singleton',
    edges: [edge('a','b'),edge('a','b','eager','alias-b'),edge('b','b'),edge('b','c','lazy'),edge('c','d'),edge('d','c')],
    removed: 2, beforeFlags: [true,true,false,false], afterFlags: [true,true,false,false],
    before: {
      eager: output([component('a',['a'],2),component('b',['b'],3),component('c',['c','d'],12)], [link('a','b')]),
      all: output([component('a',['a'],2),component('b',['b'],3),component('c',['c','d'],12)], [link('a','b'),link('b','c')]),
    },
    after: {
      eager: output([component('a',['a'],2),component('b',['b'],3),component('c',['c','d'],12)], [link('a','b')]),
      all: output([component('a',['a'],2),component('b',['b'],3),component('c',['c','d'],12)], [link('a','b'),link('b','c')]),
    },
  },
];

function check(report, mode, expected) {
  const input = JSON.stringify(report);
  const result = spawnSync(process.execPath, [cli, mode], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  assert.deepEqual(report, JSON.parse(input), 'input report remains unchanged');
}

for (const matrix of matrices) {
  test(matrix.name, () => {
    const before = { entry: 'a', modules: modules(matrix.beforeFlags), edges: matrix.edges };
    const after = { entry: 'a', modules: modules(matrix.afterFlags), edges: matrix.edges.filter((_, index) => index !== matrix.removed) };
    const restored = { ...after, modules: modules(matrix.beforeFlags), edges: [...after.edges, matrix.edges[matrix.removed]] };
    for (const mode of ['eager', 'all']) {
      for (const [report, expected] of [[before, matrix.before[mode]], [after, matrix.after[mode]], [after, matrix.after[mode]], [restored, matrix.before[mode]]]) {
        check(report, mode, expected);
        check({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, mode, expected);
      }
    }
  });
}

test('missing endpoint is rejected without exposing input', () => {
  const report = { entry: 'a', modules: modules([true,true,false,false]), edges: [edge('a','secret-missing')] };
  const original = structuredClone(report);
  for (const mode of ['eager', 'all']) {
    const result = spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
  assert.deepEqual(report, original);
});
