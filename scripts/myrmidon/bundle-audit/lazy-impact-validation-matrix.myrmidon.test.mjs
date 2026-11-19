import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const moduleRecord = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, to, kind = 'eager') => ({ from, specifier, to, kind });
const report = () => ({
  entry: 'entry',
  modules: [moduleRecord('entry', 2, true), moduleRecord('child', 3, true), moduleRecord('island', 5, false), moduleRecord('island-child', 7, false)],
  edges: [edge('entry', 'child', 'child'), edge('island', 'child', 'island-child')],
});
function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-matrix');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(file, from = 'entry', specifier = 'child') {
  const result = spawnSync(process.execPath, [cli, file, from, specifier], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function failure(result, category, label) {
  assert.equal(result.status, 1, label);
  assert.equal(result.stdout, '', label);
  assert.equal(result.stderr, `error: ${category}\n`, label);
}
function success(result, expected, label) {
  assert.equal(result.status, 0, label);
  assert.equal(result.stderr, '', label);
  assert.equal(result.stdout, JSON.stringify(expected) + '\n', label);
}

test('validates late and disconnected records before selecting or calculating impact', t => {
  const dir = fixture(t), file = join(dir, 'report.json');
  const cases = [
    ['late malformed module', r => r.modules.push({ path: 'broken', bytes: -1, eager: false }), 'shape'],
    ['late malformed edge', r => r.edges.push(edge('island', '', 'island-child')), 'shape'],
    ['late duplicate path', r => r.modules.push(moduleRecord('island', 5, false)), 'graph'],
    ['late duplicate tuple', r => r.edges.push(edge('island', 'child', 'island-child')), 'graph'],
    ['absent entry', r => { r.entry = 'absent'; }, 'graph'],
    ['disconnected absent from', r => r.edges.push(edge('absent', 'child', 'island')), 'graph'],
    ['disconnected absent to', r => r.edges.push(edge('island', 'missing', 'absent')), 'graph'],
    ['disconnected eager mismatch', r => { r.modules.at(-1).eager = true; }, 'graph'],
    ['reachable eager mismatch', r => { r.modules[1].eager = false; }, 'graph'],
  ];
  for (const [label, mutate, category] of cases) {
    const value = report(); mutate(value);
    const text = JSON.stringify(value); writeFileSync(file, text);
    failure(run(file), category, label);
    failure(run(file, 'entry', 'not-selected'), category, `${label} before selection`);
    assert.equal(readFileSync(file, 'utf8'), text, label);
  }
});

test('safe integer boundary applies to both before and after byte totals', t => {
  const file = join(fixture(t), 'report.json');
  const max = Number.MAX_SAFE_INTEGER;
  const value = report();
  value.modules[0].bytes = max - 3;
  writeFileSync(file, JSON.stringify(value));
  success(run(file), { entry: 'entry', selected: { from: 'entry', specifier: 'child', to: 'child' }, before: { modules: 2, bytes: max }, after: { modules: 1, bytes: max - 3 }, removedPaths: ['child'], savedBytes: 3 }, 'before exactly safe');
  value.modules[0].bytes = max;
  value.modules[1].bytes = 0;
  writeFileSync(file, JSON.stringify(value));
  success(run(file), { entry: 'entry', selected: { from: 'entry', specifier: 'child', to: 'child' }, before: { modules: 2, bytes: max }, after: { modules: 1, bytes: max }, removedPaths: ['child'], savedBytes: 0 }, 'after exactly safe');
  value.modules[1].bytes = 1;
  writeFileSync(file, JSON.stringify(value));
  failure(run(file), 'graph', 'before overflow');
  value.edges.push(edge('entry', 'alternate', 'child'));
  writeFileSync(file, JSON.stringify(value));
  failure(run(file), 'graph', 'after also overflows');
});

test('report text is parsed as JSON and never executed', t => {
  const dir = fixture(t), file = join(dir, 'report.json'), marker = join(dir, 'executed');
  const text = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`;
  writeFileSync(file, text);
  failure(run(file), 'json', 'JavaScript is not JSON');
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(file, 'utf8'), text);
});
