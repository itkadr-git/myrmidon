import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const moduleRecord = path => ({ path, bytes: 0, eager: true });
const known = () => ({ from: 'entry', specifier: 'resolved', kind: 'eager', to: 'target' });
const base = () => ({
  entry: 'entry',
  modules: [moduleRecord('entry'), moduleRecord('target')],
  edges: [
    { from: 'entry', specifier: 'pkg', kind: 'eager', to: null },
    { from: 'entry', specifier: './missing', kind: 'lazy', to: null },
  ],
});

function harness(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'externals-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return report => {
    const path = join(dir, 'report.json');
    writeFileSync(path, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, path], {
      encoding: 'utf8', shell: false, timeout: 10000, env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
}

test('valid known edge is validated but excluded from inventory', t => {
  const run = harness(t), report = base();
  report.edges.push(known());
  const result = run(report);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"entry":"entry","externals":[{"specifier":"pkg","eagerImporters":["entry"],"lazyImporters":[]}],"unresolvedLocal":[{"specifier":"./missing","eagerImporters":[],"lazyImporters":["entry"]}]}\n');
});

test('disconnected malformed modules fail before inventory', t => {
  const run = harness(t);
  const invalid = [
    ['null', null], ['array', []],
    ['bytes missing', { path: 'orphan', eager: true }],
    ...[null, '1', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(bytes => [`bytes ${String(bytes)}`, { path: 'orphan', bytes, eager: true }]),
    ['eager missing', { path: 'orphan', bytes: 0 }],
    ['eager not boolean', { path: 'orphan', bytes: 0, eager: 'true' }],
    ['duplicate module', moduleRecord('target')],
  ];
  for (const [name, value] of invalid) {
    const report = base(); report.edges.push(known()); report.modules.push(value);
    const result = run(report);
    assert.equal(result.status, 1, name); assert.equal(result.stdout, '', name); assert.equal(result.stderr, 'shape\n', name);
  }
});

test('invalid final known edges fail before inventory', t => {
  const run = harness(t);
  const invalid = [
    ['null', null, 'shape'], ['array', [], 'shape'],
    ['empty from', { ...known(), from: '' }, 'shape'],
    ['empty specifier', { ...known(), specifier: '' }, 'shape'],
    ['unknown kind', { ...known(), kind: 'unknown' }, 'shape'],
    ['missing to', { from: 'entry', specifier: 'resolved', kind: 'eager' }, 'shape'],
    ['number to', { ...known(), to: 1 }, 'shape'],
    ['object to', { ...known(), to: {} }, 'shape'],
    ['dangling from', { ...known(), from: 'missing' }, 'graph'],
    ['dangling to', { ...known(), to: 'missing' }, 'graph'],
    ['empty to', { ...known(), to: '' }, 'graph'],
    ['duplicate tuple', known(), 'graph'],
  ];
  for (const [name, value, category] of invalid) {
    const report = base();
    if (name === 'duplicate tuple') report.edges.push(known());
    report.edges.push(value);
    const result = run(report);
    assert.equal(result.status, 1, name); assert.equal(result.stdout, '', name); assert.equal(result.stderr, `${category}\n`, name);
  }
});
