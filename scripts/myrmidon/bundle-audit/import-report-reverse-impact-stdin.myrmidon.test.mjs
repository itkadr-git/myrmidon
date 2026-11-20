import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const report = {
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'a', bytes: 2, eager: true }, { path: 'lazy', bytes: 3, eager: false }],
  edges: [{ from: 'entry', to: 'a', kind: 'eager', specifier: './a' }, { from: 'a', to: 'lazy', kind: 'lazy', specifier: './lazy' }],
};
const input = `${JSON.stringify(report)} \n\t`;
const setup = t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-stdin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['one', 'two', 'tmp']) mkdirSync(join(dir, name));
  return dir;
};
const run = (dir, cwd, args, stdin) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, input: stdin, encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: join(dir, 'tmp') } });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
};
const expect = (result, status, stdout, stderr) => {
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
};

test('stdin matches file output across working directories and repeated runs', t => {
  const dir = setup(t), one = join(dir, 'one'), two = join(dir, 'two');
  const file = join(one, 'report.json'), dash = join(one, '-');
  writeFileSync(file, input);
  writeFileSync(dash, input);
  const expected = '{"entry":"entry","target":"a","importers":[{"path":"entry","distance":1}]}\n';
  for (const [cwd, args, stdin] of [
    [one, ['report.json', 'a'], ''], [one, ['./-', 'a'], ''],
    [one, ['-', 'a'], input], [two, ['-', 'a'], input], [two, ['-', 'a'], input],
    [two, ['../one/report.json', 'a'], ''],
  ]) expect(run(dir, cwd, args, stdin), 0, expected, '');
  assert.equal(readFileSync(file, 'utf8'), input);
  assert.equal(readFileSync(dash, 'utf8'), input);
});

test('stdin errors are atomic and argument validation has priority', t => {
  const dir = setup(t), cwd = join(dir, 'one');
  for (const invalid of ['', ' \n\t', '{"secret":', '{} {}']) {
    expect(run(dir, cwd, ['-', 'a'], invalid), 1, '', 'json\n');
  }
  expect(run(dir, cwd, ['-', 'a'], '{"secret":"sentinel"}'), 1, '', 'shape\n');
  for (const args of [[], ['-'], ['-', 'a', 'extra'], ['', 'a'], ['-', '']]) {
    expect(run(dir, cwd, args, '{"secret":'), 1, '', 'argv\n');
  }
  expect(run(dir, cwd, ['missing-sentinel', 'a'], ''), 1, '', 'file\n');
});
