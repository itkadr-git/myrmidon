import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-validate.mjs', import.meta.url));
const timeout = 10000;

const report = () => ({
  entry: 'entry.js',
  modules: [
    { path: 'entry.js', bytes: 4, eager: true },
    { path: 'lazy.js', bytes: 9, eager: false },
  ],
  edges: [
    { from: 'entry.js', specifier: './lazy.js', kind: 'lazy', to: 'lazy.js' },
    { from: 'entry.js', specifier: 'external-package', kind: 'eager', to: null },
  ],
  unknown: [
    { from: 'entry.js', specifier: 'external-package', kind: 'eager', to: null },
  ],
  counts: { modules: 2, eagerModules: 1, edges: 2 },
  bytes: { total: 13, eager: 4 },
  heaviestEager: [{ path: 'entry.js', bytes: 4, eager: true }],
});

const run = ({ cwd, executable, root }, input, args = []) => spawnSync(
  process.execPath,
  [executable, ...args],
  { cwd, input, encoding: 'utf8', timeout, env: { ...process.env, TMPDIR: root } },
);

const foreignCwds = t => {
  const root = mkdtempSync(join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(),
    'validate-stdin-protocol-',
  ));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptDir = join(root, 'cli path # %');
  mkdirSync(scriptDir);
  const script = join(scriptDir, 'import-report-validate.mjs');
  copyFileSync(cli, script);
  const executable = fileURLToPath(pathToFileURL(script));
  return ['foreign cwd one', 'foreign cwd two'].map(name => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    return { cwd, executable, root };
  });
};

const assertProcessCompleted = result => {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
};

const assertJsonFailure = result => {
  assertProcessCompleted(result);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FAIL: json\n');
};

const assertPass = result => {
  assertProcessCompleted(result);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'PASS: import report\n');
  assert.equal(result.stderr, '');
};

test('rejects empty, whitespace-only, truncated, and two-document stdin from foreign cwd paths', t => {
  for (const cwd of foreignCwds(t)) {
    for (const input of ['', ' \t\n  ', '{"entry":', `${JSON.stringify(report())}\n${JSON.stringify(report())}`]) {
      const result = run(cwd, input);
      assertJsonFailure(result);
    }
  }
});

test('accepts one complete report with a whitespace suffix from both foreign cwd paths', t => {
  for (const cwd of foreignCwds(t)) assertPass(run(cwd, `${JSON.stringify(report())} \t\n`));
});

test('reports argument failure before parsing bad stdin without echoing sentinels', t => {
  const sentinel = 'stdin-secret-sentinel';
  const argvSentinel = 'argv-secret-sentinel';
  for (const cwd of foreignCwds(t)) {
    const result = run(cwd, sentinel, [argvSentinel]);
    assertProcessCompleted(result);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'FAIL: arguments\n');
    assert.equal(result.stdout.includes(sentinel), false);
    assert.equal(result.stderr.includes(sentinel), false);
    assert.equal(result.stdout.includes(argvSentinel), false);
    assert.equal(result.stderr.includes(argvSentinel), false);
  }
});

test('classifies valid JSON with the wrong shape without echoing its sentinel', t => {
  const sentinel = 'shape-secret-sentinel';
  const input = JSON.stringify({ sentinel, entry: 'not-a-report' });
  for (const cwd of foreignCwds(t)) {
    const result = run(cwd, input);
    assertProcessCompleted(result);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'FAIL: shape\n');
    assert.equal(result.stdout.includes(sentinel), false);
    assert.equal(result.stderr.includes(sentinel), false);
  }
});
