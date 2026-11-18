import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const run = (report, bytes, modules) => spawnSync(process.execPath,
  [cli, '--max-eager-bytes', String(bytes), '--max-eager-modules', String(modules)],
  { input: JSON.stringify(report), encoding: 'utf8' });

function assertResult(result, status, expected) {
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

const fixtures = [
  { modules: [{ path: 'a', bytes: 5, eager: true }, { path: 'b', bytes: 7, eager: true }, { path: 'c', bytes: 100, eager: false }], counts: { eagerModules: 2 }, bytes: { eager: 12 } },
  { modules: [{ path: 'a', bytes: 0, eager: true }, { path: 'b', bytes: 20, eager: false }, { path: 'c', bytes: 9, eager: true }], counts: { eagerModules: 2 }, bytes: { eager: 9 } },
  { modules: [{ path: 'a', bytes: 4, eager: false }, { path: 'b', bytes: 6, eager: true }, { path: 'c', bytes: 3, eager: false }], counts: { eagerModules: 1 }, bytes: { eager: 6 } },
  { modules: [{ path: 'a', bytes: 3, eager: true }, { path: 'b', bytes: 8, eager: true }, { path: 'c', bytes: 2, eager: false }], counts: { eagerModules: 2 }, bytes: { eager: 11 } },
];
const cases = [
  [12, 2, { ok: true, eagerBytes: 12, eagerModules: 2, maxEagerBytes: 12, maxEagerModules: 2, violations: [] }],
  [8, 2, { ok: false, eagerBytes: 9, eagerModules: 2, maxEagerBytes: 8, maxEagerModules: 2, violations: ['eagerBytes'] }],
  [6, 0, { ok: false, eagerBytes: 6, eagerModules: 1, maxEagerBytes: 6, maxEagerModules: 0, violations: ['eagerModules'] }],
  [10, 1, { ok: false, eagerBytes: 11, eagerModules: 2, maxEagerBytes: 10, maxEagerModules: 1, violations: ['eagerBytes', 'eagerModules'] }],
];
const renamings = [
  ['\u96ea/\u03b1', '\u00e9/\u03b2', '\u732b/\u03b3'],
  ['a space/file', 'another space/file', 'last space/file'],
  ['../outside/a', '../outside/b', '../outside/c'],
  ['<a>&"', '<b>&"', '<c>&"'],
];

test('injective path renaming preserves complete pass and fail budget results', () => {
  for (const [index, report] of fixtures.entries()) {
    const [bytes, modules, expected] = cases[index];
    const status = expected.ok ? 0 : 1;
    assertResult(run(report, bytes, modules), status, expected);
    for (const paths of renamings) {
      const renamed = { ...report, modules: report.modules.map((item, i) => ({ ...item, path: paths[i] })) };
      assertResult(run(renamed, bytes, modules), status, expected);
    }
  }
});

test('a path collision fails closed without exposing the input', () => {
  const sentinel = 'SENTINEL_PRIVATE_PATH';
  const report = { ...fixtures[0], modules: fixtures[0].modules.map((item, i) => ({ ...item, path: i < 2 ? sentinel : item.path })) };
  const result = run(report, 12, 2);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'report error\n');
  assert.equal(result.stderr.includes(sentinel), false);
});

test('the result assertion rejects an incorrect independent expectation', () => {
  const result = run(fixtures[0], 12, 2);
  assertResult(result, 0, cases[0][2]);
  assert.throws(() => assertResult(result, 0, { ...cases[0][2], eagerBytes: 13 }), assert.AssertionError);
});
