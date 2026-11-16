import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const fixture = () => ({
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 2, eager: false },
    { path: 'sink', bytes: 7, eager: false },
    { path: 'disconnected', bytes: 13, eager: true },
  ],
  edges: [
    { from: 'entry', specifier: './sink', kind: 'eager', to: 'sink' },
    { from: 'disconnected', specifier: 'external', kind: 'lazy', to: null },
  ],
});
const expected = '{"entry":"entry","sinks":[{"path":"sink","bytes":7}],"sinkBytes":7}\n';
function run(report) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}
function valid(report) {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, '');
}
function invalid(report, category) {
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
  assert.ok(!result.stderr.includes('SECRET_SENTINEL'));
}

test('valid graph uses edges rather than module eager flags', () => {
  valid(fixture());
});

test('required report fields reject omission, null and wrong type', () => {
  for (const [field, wrong] of [['entry', 42], ['modules', {}], ['edges', {}]]) {
    for (const value of [undefined, null, wrong]) {
      const report = fixture();
      if (value === undefined) delete report[field]; else report[field] = value;
      invalid(report, 'shape');
    }
    valid(fixture());
  }
  for (const report of [null, [], 'SECRET_SENTINEL', { ...fixture(), modules: [] }, { ...fixture(), entry: '' }]) invalid(report, 'shape');
});

test('required module fields validate even disconnected modules', () => {
  for (const [field, wrong] of [['path', 42], ['bytes', '7'], ['eager', 'true']]) {
    for (const value of [undefined, null, wrong]) {
      const report = fixture();
      if (value === undefined) delete report.modules[2][field]; else report.modules[2][field] = value;
      invalid(report, 'shape');
    }
    valid(fixture());
  }
  for (const value of [null, [], 'SECRET_SENTINEL', { path: '', bytes: 1, eager: true }, { path: 'z', bytes: -1, eager: true }, { path: 'z', bytes: 1.5, eager: true }]) {
    const report = fixture(); report.modules[2] = value; invalid(report, 'shape');
  }
});

test('required edge fields validate even disconnected edges', () => {
  for (const [field, wrong] of [['from', 42], ['specifier', 42], ['kind', 42], ['to', 42]]) {
    for (const value of [undefined, null, wrong]) {
      const report = fixture();
      if (value === undefined) delete report.edges[1][field]; else report.edges[1][field] = value;
      if (field === 'to' && value === null) valid(report); else invalid(report, 'shape');
    }
    valid(fixture());
  }
  for (const value of [null, [], 'SECRET_SENTINEL', { from: '', specifier: '', kind: 'eager', to: null }, { from: 'disconnected', specifier: '', kind: 'other', to: null }, { from: 'disconnected', specifier: '', kind: 'eager', to: '' }]) {
    const report = fixture(); report.edges[1] = value; invalid(report, 'shape');
  }
  const emptySpecifier = fixture(); emptySpecifier.edges[1].specifier = ''; valid(emptySpecifier);
});

test('graph rejects duplicate paths, missing entry and disconnected broken endpoints', () => {
  const duplicate = fixture(); duplicate.modules.push({ ...duplicate.modules[2] }); invalid(duplicate, 'graph');
  const missingEntry = fixture(); missingEntry.entry = 'SECRET_SENTINEL'; invalid(missingEntry, 'graph');
  const missingFrom = fixture(); missingFrom.edges[1].from = 'SECRET_SENTINEL'; invalid(missingFrom, 'graph');
  const missingTarget = fixture(); missingTarget.edges[1].to = 'SECRET_SENTINEL'; invalid(missingTarget, 'graph');
  valid(fixture());
});

test('edge identity includes specifier, kind and target', () => {
  const duplicate = fixture(); duplicate.edges.push({ ...duplicate.edges[1] }); invalid(duplicate, 'graph');
  for (const change of [{ specifier: 'different' }, { kind: 'eager' }, { to: 'sink' }]) {
    const report = fixture(); report.edges.push({ ...report.edges[1], ...change }); valid(report);
  }
});
