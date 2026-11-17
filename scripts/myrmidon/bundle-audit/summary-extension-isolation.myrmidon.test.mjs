import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-summary.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
const extension = () => ({ annotation: sentinel, tags: ['producer', { nested: sentinel }], metadata: { path: 'decoy', counts: { modules: 999 }, note: sentinel } });
const decorate = report => ({
  ...report, ...extension(),
  modules: report.modules.map(module => ({ ...module, ...extension() })),
  edges: report.edges.map(edge => ({ ...edge, ...extension() })),
  counts: { ...report.counts, ...extension() },
  bytes: { ...report.bytes, ...extension() },
});
const check = (result, expected) => {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
  assert.ok(!result.stdout.includes(sentinel));
};
const header = '## Import report summary\n\nStatic source bytes do not establish a performance win or verify production.\n\n| Metric | Value |\n| --- | ---: |\n';
const sections = '\n### Top eager modules\n\n| Path | Bytes |\n| --- | ---: |\n';
const unresolved = '\n### Unresolved dependencies\n\n| Specifier | Kind | From |\n| --- | --- | --- |\n';
const empty = { entry: 'entry.mjs', modules: [], edges: [], counts: { modules: 0, eagerModules: 0, edges: 0 }, bytes: { total: 0, eager: 0 } };
const mixed = {
  entry: 'entry.mjs',
  modules: [{ path: 'entry.mjs', bytes: 10, eager: true }, { path: 'lazy.mjs', bytes: 5, eager: false }, { path: 'helper.mjs', bytes: 7, eager: true }],
  edges: [{ from: 'entry.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' }, { from: 'entry.mjs', specifier: './helper.mjs', kind: 'eager', to: 'helper.mjs' }],
  counts: { modules: 3, eagerModules: 2, edges: 2 }, bytes: { total: 22, eager: 17 },
};
const missing = {
  entry: 'entry.mjs', modules: [{ path: 'entry.mjs', bytes: 4, eager: true }, { path: 'other.mjs', bytes: 6, eager: false }],
  edges: [{ from: 'entry.mjs', specifier: 'zeta', kind: 'eager', to: null }, { from: 'other.mjs', specifier: 'alpha', kind: 'lazy', to: null }],
  counts: { modules: 2, eagerModules: 1, edges: 2 }, bytes: { total: 10, eager: 4 },
};
const cases = [
  ['empty', empty, header + '| modules | 0 |\n| eagerModules | 0 |\n| totalBytes | 0 |\n| eagerBytes | 0 |\n' + sections + unresolved + '\nOmitted: 0\n'],
  ['mixed', mixed, header + '| modules | 3 |\n| eagerModules | 2 |\n| totalBytes | 22 |\n| eagerBytes | 17 |\n' + sections + '| entry.mjs | 10 |\n| helper.mjs | 7 |\n' + unresolved + '\nOmitted: 0\n'],
  ['unresolved', missing, header + '| modules | 2 |\n| eagerModules | 1 |\n| totalBytes | 10 |\n| eagerBytes | 4 |\n' + sections + '| entry.mjs | 4 |\n' + unresolved + '| alpha | lazy | other.mjs |\n| zeta | eager | entry.mjs |\n\nOmitted: 0\n'],
];

test('producer extensions do not affect complete summaries, including reordered records', () => {
  for (const [name, report, expected] of cases) {
    const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
    for (const input of [report, decorate(report), reversed, decorate(reversed)]) {
      check(run(input), expected);
    }
    assert.throws(() => check(run(report), `${expected}incorrect`), assert.AssertionError, name);
  }
});

test('extensions do not bypass mandatory count validation or leak input in diagnostics', () => {
  for (const [, report] of cases) {
    const invalid = decorate({ ...report, counts: { ...report.counts, modules: report.counts.modules + 1 } });
    const result = run(invalid);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error: Invalid report\n');
    assert.ok(!result.stderr.includes(sentinel));
  }
});
