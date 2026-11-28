import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const fixture = () => ({
  entry: 'sentinel-entry',
  modules: [{ path: 'sentinel-entry', bytes: 1, eager: true }],
  edges: [{ from: 'sentinel-entry', specifier: 'sentinel-specifier', kind: 'eager', to: null }],
});
const reject = { status: 1, stdout: '', stderr: 'shape\n' };

function check(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected.status);
  assert.equal(result.stdout, expected.stdout);
  assert.equal(result.stderr, expected.stderr);
}

test('shape inputs fail closed with exact error channels', async t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(root, 'condensation-shape-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const run = report => spawnSync(process.execPath, [cli, 'all'], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, TMPDIR: tmp },
  });
  const cases = [
    ['top null', () => null], ['top array', () => []], ['top string', () => 'sentinel'],
    ['top number', () => 1], ['top boolean', () => false],
    ['entry missing', r => { delete r.entry; }], ['entry empty', r => { r.entry = ''; }],
    ['entry non-string', r => { r.entry = null; }],
    ['modules missing', r => { delete r.modules; }], ['modules non-array', r => { r.modules = {}; }],
    ['edges missing', r => { delete r.edges; }], ['edges non-array', r => { r.edges = {}; }],
    ['module null', r => { r.modules[0] = null; }], ['module array', r => { r.modules[0] = []; }],
    ['path missing', r => { delete r.modules[0].path; }], ['path empty', r => { r.modules[0].path = ''; }],
    ['path non-string', r => { r.modules[0].path = null; }],
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(value =>
      [`bytes ${String(value)}`, r => { r.modules[0].bytes = value; }]),
    ['bytes missing', r => { delete r.modules[0].bytes; }],
    ['eager missing', r => { delete r.modules[0].eager; }], ['eager non-boolean', r => { r.modules[0].eager = 'true'; }],
    ['edge null', r => { r.edges[0] = null; }], ['edge array', r => { r.edges[0] = []; }],
    ...['from', 'specifier', 'kind', 'to'].flatMap(field => [
      [`${field} missing`, r => { delete r.edges[0][field]; }],
      [`${field} empty`, r => { r.edges[0][field] = ''; }],
      [`${field} non-string`, r => { r.edges[0][field] = 42; }],
    ]),
    ['kind unknown', r => { r.edges[0].kind = 'other'; }],
    ['from null', r => { r.edges[0].from = null; }],
    ['specifier null', r => { r.edges[0].specifier = null; }],
    ['kind null', r => { r.edges[0].kind = null; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const report = fixture();
      const replacement = mutate(report);
      check(run(replacement === undefined ? report : replacement), reject);
    });
  }
  await t.test('oracle rejects a corrupted expected result', () => {
    const report = fixture();
    report.entry = '';
    const result = run(report);
    check(result, reject);
    assert.throws(() => check(result, { ...reject, stderr: 'graph\n' }), assert.AssertionError);
  });
  for (const bytes of [0, Number.MAX_SAFE_INTEGER]) {
    await t.test(`valid single module bytes ${bytes}`, () => {
      const report = fixture();
      report.modules[0].bytes = bytes;
      const expected = { entry: 'sentinel-entry', components: [{ id: 'sentinel-entry', paths: ['sentinel-entry'], bytes }], edges: [] };
      check(run(report), { status: 0, stdout: `${JSON.stringify(expected)}\n`, stderr: '' });
    });
  }
});
