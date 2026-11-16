import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
function fixture(t) {
  const dir = mkdtempSync(join(root, 'cycles-stdin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: cwd },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `FAIL: ${category}\n`);
}

test('stdin matches file output across working directories, repeats, and literal dash path', t => {
  const dir = fixture(t), other = join(dir, 'other'); mkdirSync(other);
  const report = {
    entry: 'a', modules: ['a', 'b', 'c'].map(path => ({ path, bytes: 1, eager: true })),
    edges: [
      { from: 'a', to: 'b', specifier: 'b', kind: 'eager' },
      { from: 'b', to: 'c', specifier: 'c', kind: 'eager' },
      { from: 'c', to: 'a', specifier: 'a', kind: 'lazy' },
    ],
  };
  const input = JSON.stringify(report) + ' \n\t';
  writeFileSync(join(dir, 'report.json'), input);
  writeFileSync(join(dir, '-'), input);
  const expected = JSON.stringify({ entry: 'a', eagerCycles: [], allCycles: [['a', 'b', 'c']] }) + '\n';
  for (const [cwd, args, stdin] of [
    [dir, ['report.json'], ''], [dir, ['./-'], 'not JSON'],
    [dir, ['-'], input], [other, ['-'], input], [other, ['-'], input],
    [other, ['../report.json'], ''],
  ]) {
    const result = run(cwd, args, stdin);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  }
  assert.equal(readFileSync(join(dir, 'report.json'), 'utf8'), input);
  assert.equal(readFileSync(join(dir, '-'), 'utf8'), input);
});

test('stdin rejects malformed JSON and shape atomically', t => {
  const dir = fixture(t);
  for (const input of ['', ' \n\t', '{"sentinel":', '{} {}']) failure(run(dir, ['-'], input), 'json');
  failure(run(dir, ['-'], '{"sentinel":"private"}'), 'shape');
});

test('argument count precedes stdin parsing', t => {
  const dir = fixture(t);
  failure(run(dir, [], 'sentinel invalid JSON'), 'arguments');
  failure(run(dir, ['-', 'extra'], 'sentinel invalid JSON'), 'arguments');
});
