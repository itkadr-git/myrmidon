import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const run = input => spawnSync(process.execPath, [cli], { input, encoding: 'utf8' });

// Totals and expected rows are specified independently of the input transformation.
const cases = [
  { modules: [['z', 8, true], ['b', 5, true], ['a', 5, true], ['lazy', 2, false]], total: 20, eager: 18, rows: [['z', 8], ['a', 5], ['b', 5]], zero: ['a', 'b', 'z'] },
  { modules: [['c', 2, true], ['a', 9, false], ['b', 4, true]], total: 15, eager: 6, rows: [['b', 4], ['c', 2]], zero: ['b', 'c'] },
  { modules: [['z', 3, false], ['a', 7, true], ['b', 7, true], ['c', 1, true]], total: 18, eager: 15, rows: [['a', 7], ['b', 7], ['c', 1]], zero: ['a', 'b', 'c'] },
  { modules: [['q', 11, true], ['a', 1, true], ['b', 6, false], ['r', 4, true]], total: 22, eager: 16, rows: [['q', 11], ['r', 4], ['a', 1]], zero: ['a', 'q', 'r'] },
];

function fixture(c, k, reverse) {
  const modules = c.modules.map(([path, bytes, eager]) => ({ path, bytes: bytes * k, eager }));
  const edges = [
    { from: c.modules[0][0], specifier: 'missing-z', kind: 'lazy', to: null },
    { from: c.modules[1][0], specifier: 'missing-a', kind: 'eager', to: null },
    { from: c.modules[0][0], specifier: './linked', kind: 'eager', to: c.modules[1][0] },
  ];
  return {
    modules: reverse ? modules.reverse() : modules,
    edges: reverse ? edges.reverse() : edges,
    counts: { modules: c.modules.length, eagerModules: c.rows.length, edges: 3 },
    bytes: { total: c.total * k, eager: c.eager * k },
  };
}

function expected(c, k) {
  const rows = k === 0 ? c.zero.map(path => `| ${path} | 0 |`) : c.rows.map(([path, bytes]) => `| ${path} | ${bytes * k} |`);
  return [
    '## Import report summary', '',
    'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |',
    `| modules | ${c.modules.length} |`, `| eagerModules | ${c.rows.length} |`,
    `| totalBytes | ${c.total * k} |`, `| eagerBytes | ${c.eager * k} |`, '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |', ...rows, '',
    '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |',
    `| missing-a | eager | ${c.modules[1][0]} |`,
    `| missing-z | lazy | ${c.modules[0][0]} |`, '', 'Omitted: 0', '',
  ].join('\n');
}

function assertSuccess(result, markdown) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, markdown);
}

test('scaling preserves topology, counts, unresolved rows and positive-weight ordering across permutations', () => {
  for (const c of cases) for (const k of [1, 3, 7]) for (const reverse of [false, true]) {
    assertSuccess(run(JSON.stringify(fixture(c, k, reverse))), expected(c, k));
  }
});

test('zero weights sort all eager paths lexically across permutations', () => {
  for (const c of cases) for (const reverse of [false, true]) {
    assertSuccess(run(JSON.stringify(fixture(c, 0, reverse))), expected(c, 0));
  }
});

test('the same assertion rejects an incorrect byte cell', () => {
  const result = run(JSON.stringify(fixture(cases[0], 3, false)));
  const correct = expected(cases[0], 3);
  assertSuccess(result, correct);
  const wrong = correct.replace('| z | 24 |', '| z | 25 |');
  assert.notEqual(wrong, correct);
  assert.throws(() => assertSuccess(result, wrong), assert.AssertionError);
});

test('invalid totals and malformed JSON produce only a diagnostic category', () => {
  const report = fixture(cases[0], 3, false);
  report.bytes.total += 1;
  for (const [input, category] of [[JSON.stringify(report), 'Invalid report'], ['private-input{', 'Invalid JSON']]) {
    const result = run(input);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `Error: ${category}\n`);
    assert.doesNotMatch(result.stderr, /private-input|missing-a/);
  }
});
