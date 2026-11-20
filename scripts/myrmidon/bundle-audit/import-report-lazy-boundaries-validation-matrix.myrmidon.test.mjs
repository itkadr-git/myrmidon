import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'target', bytes: 2, eager: false },
    { path: 'detached', bytes: 3, eager: false },
    { path: 'other', bytes: 4, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: 'target', kind: 'lazy', to: 'target' },
    { from: 'detached', specifier: 'one', kind: 'lazy', to: 'other' },
    { from: 'detached', specifier: 'two', kind: 'lazy', to: 'other' },
    { from: 'other', specifier: 'unknown', kind: 'lazy', to: null },
  ],
};
const expected = { entry: 'entry', boundaries: [{ from: 'entry', specifier: 'target', to: 'target', bytes: 2 }] };
const cases = [
  ['module is not an object', 'shape', r => { r.modules[2] = null; }],
  ['module path has wrong type', 'shape', r => { r.modules[2].path = 5; }],
  ['module path is empty', 'shape', r => { r.modules[2].path = ''; }],
  ['negative bytes', 'shape', r => { r.modules[2].bytes = -1; }],
  ['fractional bytes', 'shape', r => { r.modules[2].bytes = 1.5; }],
  ['non-numeric bytes', 'shape', r => { r.modules[2].bytes = '3'; }],
  ['unsafe bytes', 'shape', r => { r.modules[2].bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['eager flag has wrong type', 'shape', r => { r.modules[2].eager = 'false'; }],
  ['duplicate module path', 'graph', r => { r.modules[2].path = 'other'; }],
  ['edge is not an object', 'shape', r => { r.edges[1] = null; }],
  ['edge source has wrong type', 'shape', r => { r.edges[1].from = 1; }],
  ['edge specifier has wrong type', 'shape', r => { r.edges[1].specifier = null; }],
  ['edge kind is invalid', 'shape', r => { r.edges[1].kind = 'unknown'; }],
  ['edge destination has wrong type', 'shape', r => { r.edges[1].to = false; }],
  ['edge destination is empty', 'shape', r => { r.edges[1].to = ''; }],
  ['missing source', 'graph', r => { r.edges[1].from = 'missing'; }],
  ['missing destination', 'graph', r => { r.edges[1].to = 'missing'; }],
  ['duplicate edge', 'graph', r => { r.edges[2].specifier = 'one'; }],
  ['disconnected module marked eager', 'graph', r => { r.modules[2].eager = true; }],
  ['eager edge contradicts closure', 'graph', r => { r.edges[0].kind = 'eager'; }],
];

function run(t, report) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'lazy-validation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(report));
  const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test('valid disconnected graph and unknown lazy endpoint do not change boundaries', t => {
  const result = run(t, fixture);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('safe bytes in disconnected modules have no global total gate', t => {
  const report = structuredClone(fixture);
  report.modules[2].bytes = Number.MAX_SAFE_INTEGER;
  const result = run(t, report);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

for (const [label, category, change] of cases) {
  test(`rejects ${label} outside the selected result`, t => {
    const report = structuredClone(fixture);
    change(report);
    const result = run(t, report);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  });
}
