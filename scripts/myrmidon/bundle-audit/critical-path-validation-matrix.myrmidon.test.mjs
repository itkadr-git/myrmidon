import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleRecord = (path, bytes = 1) => ({ path, bytes, eager: true });
const edge = (from, to, specifier = to) => ({ from, to, specifier, kind: 'eager' });
const base = () => ({ entry: 'entry', modules: [moduleRecord('entry', 2), moduleRecord('reachable', 3), moduleRecord('unreachable')], edges: [edge('entry', 'reachable')] });

function run(report) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function invalid(report, category, label) {
  const result = run(report);
  assert.equal(result.status, 1, label);
  assert.equal(result.stdout, '', label);
  assert.equal(result.stderr, `${category}\n`, label);
}

test('valid unreachable eager cycle does not affect the exact result', () => {
  const report = base();
  report.modules.push(moduleRecord('other'));
  report.edges.push(edge('unreachable', 'other'), edge('other', 'unreachable'));
  const result = run(report);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"entry":"entry","paths":["entry","reachable"],"bytes":5}\n');
});

test('late malformed modules reject the whole report with shape channel', () => {
  const malformed = [
    ['null', null], ['array', []], ['missing path', { bytes: 1, eager: true }],
    ['empty path', moduleRecord('')], ['non-string path', moduleRecord(3)],
    ['missing bytes', { path: 'bad', eager: true }], ['negative bytes', moduleRecord('bad', -1)],
    ['fractional bytes', moduleRecord('bad', 0.5)], ['unsafe bytes', moduleRecord('bad', Number.MAX_SAFE_INTEGER + 1)],
    ['string bytes', moduleRecord('bad', '1')], ['missing eager', { path: 'bad', bytes: 1 }],
    ['non-boolean eager', { path: 'bad', bytes: 1, eager: 'true' }],
  ];
  for (const [label, record] of malformed) {
    const report = base(); report.modules.push(record);
    invalid(report, 'shape', label);
  }
});

test('late malformed unreachable edges reject the whole report with shape channel', () => {
  const valid = edge('unreachable', 'unreachable');
  const malformed = [
    ['null', null], ['array', []], ['missing from', { ...valid, from: undefined }],
    ['empty from', { ...valid, from: '' }], ['non-string from', { ...valid, from: 7 }],
    ['missing to', { ...valid, to: undefined }], ['empty to', { ...valid, to: '' }],
    ['non-string to', { ...valid, to: 7 }], ['missing specifier', { ...valid, specifier: undefined }],
    ['non-string specifier', { ...valid, specifier: 7 }], ['missing kind', { ...valid, kind: undefined }],
    ['invalid kind', { ...valid, kind: 'other' }],
  ];
  for (const [label, record] of malformed) {
    const report = base(); report.edges.push(record);
    invalid(report, 'shape', label);
  }
});

test('duplicate records and missing endpoints reject the whole report with graph channel', () => {
  const cases = [
    ['duplicate unreachable path', r => r.modules.push(moduleRecord('unreachable', 9))],
    ['missing entry', r => { r.entry = 'missing'; }],
    ['missing unreachable from', r => r.edges.push(edge('missing', 'unreachable'))],
    ['missing unreachable to', r => r.edges.push(edge('unreachable', 'missing'))],
    ['duplicate unreachable tuple', r => { r.edges.push(edge('unreachable', null, 'external'), edge('unreachable', null, 'external')); }],
  ];
  for (const [label, change] of cases) {
    const report = base(); change(report);
    invalid(report, 'graph', label);
  }
});

test('top-level shape violations reject before any result', () => {
  const cases = [null, [], {}, { ...base(), entry: '' }, { ...base(), entry: 3 },
    { ...base(), modules: null }, { ...base(), edges: null }];
  for (const value of cases) invalid(value, 'shape', JSON.stringify(value));
});
