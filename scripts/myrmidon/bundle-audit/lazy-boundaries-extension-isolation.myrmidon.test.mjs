import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'eager', bytes: 2, eager: true },
    { path: 'lazy', bytes: 3, eager: false },
    { path: 'leaf', bytes: 5, eager: false },
    { path: 'disconnected', bytes: 7, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: 'eager-import', kind: 'eager', to: 'eager' },
    { from: 'entry', specifier: 'load', kind: 'lazy', to: 'lazy' },
    { from: 'lazy', specifier: 'leaf-import', kind: 'eager', to: 'leaf' },
    { from: 'leaf', specifier: 'cycle', kind: 'eager', to: 'lazy' },
    { from: 'entry', specifier: 'alternate', kind: 'lazy', to: 'eager' },
    { from: 'disconnected', specifier: 'unreachable', kind: 'lazy', to: 'leaf' },
    { from: 'entry', specifier: 'unresolved', kind: 'lazy', to: null },
  ],
};
const oracle = '{"entry":"entry","boundaries":[{"from":"entry","specifier":"load","to":"lazy","bytes":8}]}\n';
const changedOracle = '{"entry":"entry","boundaries":[{"from":"entry","specifier":"load","to":"lazy","bytes":9}]}\n';
const values = [null, true, 42, 'annotation', [null, false, 9, 'x', { nested: [1, 2] }], { nested: { list: [null, true, 3, 'x'] } }];
const shadows = ['counts', 'totalBytes', 'boundaries', 'metadata'];

function annotate(report, level, fields) {
  const copy = structuredClone(report);
  if (level === 'report' || level === 'all') Object.assign(copy, structuredClone(fields));
  if (level === 'modules' || level === 'all') copy.modules.forEach(item => Object.assign(item, structuredClone(fields)));
  if (level === 'edges' || level === 'all') copy.edges.forEach(item => Object.assign(item, structuredClone(fields)));
  return copy;
}

function check(path, report, expected = oracle, error = '') {
  const input = JSON.stringify(report);
  writeFileSync(path, input);
  for (const mode of ['file', 'stdin']) {
    const result = spawnSync(process.execPath, [cli, mode === 'file' ? path : '-'], {
      encoding: 'utf8', timeout: 5000, input: mode === 'stdin' ? input : undefined,
    });
    assert.equal(result.error, undefined, mode);
    assert.equal(result.signal, null, mode);
    assert.equal(result.status, error ? 1 : 0, mode);
    assert.equal(result.stdout, error ? '' : expected, mode);
    assert.equal(result.stderr, error ? `${error}\n` : '', mode);
    assert.equal(readFileSync(path, 'utf8'), input, mode);
  }
}

function scratch(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-isolation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
}

test('unknown annotations and shadow fields are isolated at every level', t => {
  const path = scratch(t);
  check(path, fixture);
  for (const level of ['report', 'modules', 'edges', 'all']) {
    for (const value of values) {
      check(path, annotate(fixture, level, { annotation: value }));
      for (const shadow of shadows) check(path, annotate(fixture, level, { [shadow]: value }));
    }
    const combined = { annotation: values, counts: null, totalBytes: false, boundaries: [1, { nested: true }], metadata: { nested: { value: 'ignored' } } };
    check(path, annotate(fixture, level, combined));
  }
});

test('separate processes preserve A/B/A output and input files', t => {
  const path = scratch(t);
  const annotated = annotate(fixture, 'all', { metadata: { nested: [null, true, 12, 'x'] }, boundaries: ['shadow'] });
  check(path, fixture);
  check(path, annotated);
  check(path, fixture);
});

test('real graph and byte fields remain significant with annotations', t => {
  const path = scratch(t);
  const report = annotate(fixture, 'all', { metadata: { nested: ['ignored'] }, totalBytes: 999 });
  const bytes = structuredClone(report);
  bytes.modules.find(item => item.path === 'lazy').bytes = 4;
  check(path, bytes, changedOracle);
  const eager = structuredClone(report);
  eager.modules.find(item => item.path === 'leaf').eager = true;
  check(path, eager, '', 'graph');
  const invalid = structuredClone(report);
  invalid.modules.find(item => item.path === 'lazy').bytes = -1;
  check(path, invalid, '', 'shape');
});
