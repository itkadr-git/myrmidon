import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-explain.mjs');
const budget = join(dir, 'import-budget.mjs');
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
const moduleRecord = path => ({ path, bytes: 0, eager: false });
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });
const report = () => ({ entry: 'entry', modules: ['entry', 'a', 'b', 'c', 'target', 'lazy', 'disconnected'].map(moduleRecord), edges: [edge('entry', 'b'), edge('entry', 'a'), edge('a', 'c'), edge('c', 'target'), edge('a', 'target'), edge('b', 'target'), edge('target', 'entry'), edge('entry', 'lazy', 'lazy'), edge('a', null)] });
function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const path = mkdtempSync(join(root, 'explain-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function expectSuccess(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function expectError(result, category) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, category + '\n');
}
test('diamond shortest path is lexical and independent of record order', t => {
  const root = fixture(t), path = join(root, 'report.json'), data = report();
  for (const reversed of [false, true]) {
    if (reversed) { data.edges.reverse(); data.modules.reverse(); }
    const input = JSON.stringify(data); writeFileSync(path, input);
    expectSuccess(run(cli, [path, 'target']), { entry: 'entry', target: 'target', reachable: true, path: ['entry', 'a', 'target'] });
    assert.equal(readFileSync(path, 'utf8'), input);
  }
});
test('entry, lazy-only, disconnected and missing targets', t => {
  const path = join(fixture(t), 'report.json'); writeFileSync(path, JSON.stringify(report()));
  for (const [target, reachable, chain] of [['entry', true, ['entry']], ['lazy', false, []], ['disconnected', false, []]])
    expectSuccess(run(cli, [path, target]), { entry: 'entry', target, reachable, path: chain });
  expectError(run(cli, [path, 'missing']), 'error: target');
});
test('invalid inputs have stable errors and no partial output', t => {
  const path = join(fixture(t), 'report.json');
  expectError(run(cli, []), 'error: arguments');
  expectError(run(cli, [path, 'target']), 'error: read');
  writeFileSync(path, '{'); expectError(run(cli, [path, 'target']), 'error: json');
  const cases = [null, [], {}, { ...report(), entry: 'missing' }, { ...report(), modules: [...report().modules, moduleRecord('a')] }, { ...report(), modules: [{ path: 'entry', bytes: -1, eager: true }], edges: [] }, { ...report(), modules: [{ path: 'entry', bytes: Number.MAX_SAFE_INTEGER + 1, eager: true }], edges: [] }, { ...report(), edges: [edge('missing', 'a')] }, { ...report(), edges: [edge('entry', 'missing')] }, { ...report(), edges: [edge('entry', 'a'), edge('entry', 'a')] }, { ...report(), edges: [{ ...edge('entry', 'a'), kind: 'other' }] }, { ...report(), edges: [{ ...edge('entry', 'a'), specifier: '' }] }, { ...report(), modules: [{ path: '', bytes: 0, eager: true }] }];
  for (const value of cases) { writeFileSync(path, JSON.stringify(value)); expectError(run(cli, [path, 'target']), 'error: report'); }
});
test('accepts an actual import-budget report without executing input', t => {
  const root = fixture(t), entry = join(root, 'entry.mjs'), target = join(root, 'target.mjs'), file = join(root, 'report.json');
  writeFileSync(entry, "import './target.mjs';\nthrow new Error('must not execute');\n");
  writeFileSync(target, 'export const value = 1;\n');
  const result = run(budget, [entry]); assert.equal(result.status, 0); assert.equal(result.stderr, '');
  writeFileSync(file, result.stdout);
  expectSuccess(run(cli, [file, 'target.mjs']), { entry: 'entry.mjs', target: 'target.mjs', reachable: true, path: ['entry.mjs', 'target.mjs'] });
});
