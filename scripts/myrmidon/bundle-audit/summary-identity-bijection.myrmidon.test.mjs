import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });

// The expected rows are independent tables, not derived from the CLI output.
const cases = [
  { weights: [7, 7, 2], names: ['zulu', 'alpha', 'mike'], eager: [['alpha', 7], ['zulu', 7]], unknown: ['alpha', 'zulu'], total: 16, eagerBytes: 14 },
  { weights: [3, 9, 4], names: ['delta', 'xray', 'bravo'], eager: [['xray', 9], ['delta', 3]], unknown: ['delta', 'xray'], total: 16, eagerBytes: 12 },
  { weights: [0, 0, 8], names: ['november', 'hotel', 'india'], eager: [['hotel', 0], ['november', 0]], unknown: ['hotel', 'november'], total: 8, eagerBytes: 0 },
  { weights: [10, 1, 5], names: ['tango', 'sierra', 'romeo'], eager: [['tango', 10], ['sierra', 1]], unknown: ['sierra', 'tango'], total: 16, eagerBytes: 11 },
];

function fixture(c) {
  return {
    entry: 'oldA',
    modules: [
      { path: 'oldA', bytes: c.weights[0], eager: true },
      { path: 'oldB', bytes: c.weights[1], eager: true },
      { path: 'oldC', bytes: c.weights[2], eager: false },
    ],
    edges: [
      { from: 'oldA', to: 'oldC', specifier: 'local', kind: 'eager' },
      { from: 'oldB', to: 'oldA', specifier: 'local', kind: 'lazy' },
      { from: 'oldA', to: null, specifier: 'missing', kind: 'eager' },
      { from: 'oldB', to: null, specifier: 'missing', kind: 'eager' },
    ],
    counts: { modules: 3, eagerModules: 2, edges: 4 },
    bytes: { total: c.total, eager: c.eagerBytes },
  };
}

function rename(report, names) {
  const map = new Map([['oldA', names[0]], ['oldB', names[1]], ['oldC', names[2]]]);
  return {
    ...report,
    entry: map.get(report.entry),
    modules: report.modules.map(m => ({ ...m, path: map.get(m.path) })),
    edges: report.edges.map(e => ({ ...e, from: map.get(e.from), to: e.to === null ? null : map.get(e.to) })),
  };
}

function expected(c) {
  return [
    '## Import report summary', '',
    'Static source bytes do not establish a performance win or verify production.', '',
    '| Metric | Value |', '| --- | ---: |', '| modules | 3 |', '| eagerModules | 2 |',
    `| totalBytes | ${c.total} |`, `| eagerBytes | ${c.eagerBytes} |`, '',
    '### Top eager modules', '', '| Path | Bytes |', '| --- | ---: |',
    ...c.eager.map(([name, bytes]) => `| ${name} | ${bytes} |`), '',
    '### Unresolved dependencies', '', '| Specifier | Kind | From |', '| --- | --- | --- |',
    ...c.unknown.map(name => `| missing | eager | ${name} |`), '', 'Omitted: 0', '',
  ].join('\n');
}

function assertSuccess(result, output) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, output);
}

for (const [index, c] of cases.entries()) {
  test(`consistent identity bijection preserves metrics and reorders rows ${index + 1}`, () => {
    const renamed = rename(fixture(c), c.names);
    const result = run(renamed);
    assertSuccess(result, expected(c));
    for (const old of ['oldA', 'oldB', 'oldC']) assert.ok(!result.stdout.includes(old));
    assert.throws(() => assertSuccess(result, expected({ ...c, total: c.total + 1 })), assert.AssertionError);
  });
}

test('rejects colliding paths and dangling endpoints without leaking input', () => {
  const collision = rename(fixture(cases[0]), cases[0].names);
  collision.modules[1].path = collision.modules[0].path;
  const danglingFrom = rename(fixture(cases[0]), cases[0].names);
  danglingFrom.edges[0].from = 'secretFrom';
  const danglingTo = rename(fixture(cases[0]), cases[0].names);
  danglingTo.edges[0].to = 'secretTo';
  for (const report of [collision, danglingFrom, danglingTo]) {
    const result = run(report);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error: Invalid report\n');
  }
});
