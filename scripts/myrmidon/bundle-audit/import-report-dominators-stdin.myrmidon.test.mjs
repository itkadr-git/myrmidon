import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const report = JSON.stringify({ entry: 'a', modules: [
  { path: 'a', bytes: 1, eager: true }, { path: 'b', bytes: 2, eager: true },
  { path: 'c', bytes: 3, eager: false },
], edges: [
  { from: 'a', to: 'b', kind: 'eager', specifier: './b' },
  { from: 'b', to: 'c', kind: 'lazy', specifier: './c' },
] });

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dominators-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'one'), cwd2 = join(root, 'two');
  mkdirSync(cwd1); mkdirSync(cwd2);
  writeFileSync(join(cwd1, 'report.json'), report);
  writeFileSync(join(cwd1, '-'), report);
  return { root, cwd1, cwd2 };
}
function run(root, cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: root },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

test('stdin matches file output across working directories and repeat runs', t => {
  const { root, cwd1, cwd2 } = fixture(t);
  const file = run(root, cwd1, ['report.json', 'b'], '');
  assert.equal(file.status, 0); assert.equal(file.stderr, '');
  assert.equal(file.stdout, '{"entry":"a","target":"b","dominators":["a","b"]}\n');
  for (const cwd of [cwd1, cwd2, cwd1]) {
    const result = run(root, cwd, ['-', 'b'], report + ' \n\t');
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.equal(result.stdout, file.stdout);
  }
  const dash = run(root, cwd1, ['./-', 'b'], 'not JSON');
  assert.equal(dash.status, 0); assert.equal(dash.stderr, ''); assert.equal(dash.stdout, file.stdout);
  assert.equal(readFileSync(join(cwd1, 'report.json'), 'utf8'), report);
  assert.equal(readFileSync(join(cwd1, '-'), 'utf8'), report);
});

test('stdin errors are atomic and argv errors take precedence', t => {
  const { root, cwd1 } = fixture(t);
  for (const input of ['', ' \n\t', '{"sentinel":', '{} {}']) failure(run(root, cwd1, ['-', 'b'], input), 'json');
  failure(run(root, cwd1, ['-', 'b'], '{"sentinel":true}'), 'shape');
  for (const args of [[], ['-'], ['-', 'b', 'extra'], ['-', '']]) failure(run(root, cwd1, args, '{"sentinel":'), 'argv');
  failure(run(root, cwd1, ['missing', 'b'], ''), 'read');
});
