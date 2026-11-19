import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
const a = {
  modules: [{ path: 'a-z', bytes: 30, eager: true }, { path: 'a-lazy', bytes: 7, eager: false }, { path: 'a-a', bytes: 30, eager: true }],
  edges: [{ from: 'a-z', specifier: './a-lazy', kind: 'lazy', to: 'a-lazy' }, { from: 'a-z', specifier: 'shared', kind: 'lazy', to: null }, { from: 'a-a', specifier: 'shared', kind: 'eager', to: null }],
};
const b = {
  modules: [{ path: 'b-z', bytes: 30, eager: true }, { path: 'b-lazy', bytes: 11, eager: false }, { path: 'b-a', bytes: 50, eager: true }],
  edges: [{ from: 'b-a', specifier: './b-z', kind: 'eager', to: 'b-z' }, { from: 'b-z', specifier: 'shared', kind: 'eager', to: null }, { from: 'b-a', specifier: 'alpha', kind: 'lazy', to: null }],
};
function report(modules, edges) {
  return { entry: 'a-z', modules, edges, unknown: edges.filter(e => e.to === null),
    counts: { modules: modules.length, eagerModules: modules.filter(m => m.eager).length, edges: edges.length },
    bytes: { total: modules.reduce((sum, m) => sum + m.bytes, 0), eager: modules.filter(m => m.eager).reduce((sum, m) => sum + m.bytes, 0) }, heaviestEager: [] };
}
function markdown(metrics, eager, unresolved) {
  return ['## Import report summary', '', 'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |', ...metrics, '', '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
    ...eager, '', '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |', ...unresolved, '', 'Omitted: 0', ''].join('\n');
}
const expectedA = markdown(['| modules | 3 |', '| eagerModules | 2 |', '| totalBytes | 67 |', '| eagerBytes | 60 |'],
  ['| a-a | 30 |', '| a-z | 30 |'], ['| shared | eager | a-a |', '| shared | lazy | a-z |']);
const expectedB = markdown(['| modules | 3 |', '| eagerModules | 2 |', '| totalBytes | 91 |', '| eagerBytes | 80 |'],
  ['| b-a | 50 |', '| b-z | 30 |'], ['| alpha | lazy | b-a |', '| shared | eager | b-z |']);
const expectedUnion = markdown(['| modules | 6 |', '| eagerModules | 4 |', '| totalBytes | 158 |', '| eagerBytes | 140 |'],
  ['| b-a | 50 |', '| a-a | 30 |', '| a-z | 30 |', '| b-z | 30 |'],
  ['| alpha | lazy | b-a |', '| shared | eager | a-a |', '| shared | eager | b-z |', '| shared | lazy | a-z |']);
function success(result, expected) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

test('disjoint reports compose additively and sort all rows in either order', () => {
  success(run(JSON.stringify(report(a.modules, a.edges))), expectedA);
  success(run(JSON.stringify(report(b.modules, b.edges))), expectedB);
  const ab = run(JSON.stringify(report([...a.modules, ...b.modules], [...a.edges, ...b.edges])));
  const ba = run(JSON.stringify(report([...b.modules, ...a.modules], [...b.edges, ...a.edges])));
  success(ab, expectedUnion);
  success(ba, expectedUnion);
  assert.equal(ab.stdout, ba.stdout);
  assert.throws(() => success(ab, expectedUnion.replace('| totalBytes | 158 |', '| totalBytes | 159 |')), assert.AssertionError);
});

test('invalid inputs fail without exposing input', () => {
  const valid = report(a.modules, a.edges);
  const cases = [
    ['SECRET{', [], /Invalid JSON/],
    [JSON.stringify({ ...valid, counts: { ...valid.counts, modules: 99 }, entry: 'SECRET' }), [], /Invalid report/],
    [JSON.stringify({ ...valid, edges: [...valid.edges, { from: 'a-z', specifier: 'SECRET', kind: 'invalid', to: null }] }), [], /Invalid report/],
    [JSON.stringify(valid), ['SECRET'], /Invalid arguments/],
  ];
  for (const [input, args, category] of cases) {
    const result = run(input, args);
    assert.equal(result.signal, null);
    assert.ok(Number.isInteger(result.status) && result.status !== 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, category);
    assert.doesNotMatch(result.stderr, /SECRET/);
  }
});
