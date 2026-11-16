import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-explain.mjs');
const run = (cwd, args, input = '') => spawnSync(process.execPath, [cli, ...args], {
  cwd,
  env: { ...process.env, TMPDIR: cwd },
  encoding: 'utf8',
  input,
  timeout: 10000,
});
const moduleRecord = path => ({ path, bytes: 0, eager: false });
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });
const report = () => ({
  entry: 'entry',
  modules: ['entry', 'a', 'b', 'target', 'lazy'].map(moduleRecord),
  edges: [
    edge('entry', 'b'), edge('entry', 'a'), edge('a', 'target'),
    edge('entry', 'lazy', 'lazy'), edge('a', null),
  ],
});
const root = () => process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
function fixture(t) {
  const path = mkdtempSync(join(root(), 'explain-stdin-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function assertProcess(result, status, stdout, stderr) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
}

test('stdin is byte-for-byte equivalent to a report file from foreign cwd', t => {
  const path = fixture(t), file = join(path, 'report.json'), input = `${JSON.stringify(report())} \n\t`;
  writeFileSync(file, input);
  const expected = JSON.stringify({ entry: 'entry', target: 'target', reachable: true, path: ['entry', 'a', 'target'] }) + '\n';
  for (const cwd of [path, dirname(path)]) {
    const fromFile = run(cwd, [file, 'target']);
    const fromStdin = run(cwd, ['-', 'target'], input);
    assertProcess(fromFile, 0, expected, '');
    assertProcess(fromStdin, 0, expected, '');
  }
  assertProcess(run(path, ['report.json', 'target']), 0, expected, '');
  assert.equal(readFileSync(file, 'utf8'), input);
});

test('exact ./- remains a regular file and repeated runs are stable', t => {
  const path = fixture(t), input = JSON.stringify(report()), literalDash = join(path, '-');
  writeFileSync(literalDash, input);
  const expected = JSON.stringify({ entry: 'entry', target: 'target', reachable: true, path: ['entry', 'a', 'target'] }) + '\n';
  for (let i = 0; i < 2; i++) assertProcess(run(path, ['./-', 'target']), 0, expected, '');
  assert.equal(readFileSync(literalDash, 'utf8'), input);
});

test('stdin rejects malformed JSON atomically', t => {
  const cwd = fixture(t);
  for (const input of ['', ' \n\t', '{', `${JSON.stringify(report())}\n${JSON.stringify(report())}`])
    assertProcess(run(cwd, ['-', 'target'], input), 1, '', 'error: json\n');
});

test('stdin rejects structurally invalid reports without leaking input', t => {
  const cwd = fixture(t);
  for (const input of ['null', JSON.stringify({ ...report(), entry: 'missing' }), JSON.stringify({ ...report(), modules: [] })])
    assertProcess(run(cwd, ['-', 'target'], input), 1, '', 'error: report\n');
});

test('argument errors take priority over stdin content', t => {
  const cwd = fixture(t);
  for (const args of [[], ['-', 'target', 'extra']])
    assertProcess(run(cwd, args, '{'), 1, '', 'error: arguments\n');
});
