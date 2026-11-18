import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const report = {
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'eager', bytes: 2, eager: true }, { path: 'lazy', bytes: 3, eager: false }],
  edges: [
    { from: 'entry', specifier: './eager', kind: 'eager', to: 'eager' },
    { from: 'entry', specifier: './lazy', kind: 'lazy', to: 'lazy' },
    { from: 'eager', specifier: 'pkg', kind: 'eager', to: null },
    { from: 'lazy', specifier: 'pkg/sub', kind: 'lazy', to: null },
  ],
};
const source = JSON.stringify(report) + ' \n\t';
const expected = JSON.stringify({ entry: 'entry', externals: [
  { specifier: 'pkg', eagerImporters: ['eager'], lazyImporters: [] },
  { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['lazy'] },
], unresolvedLocal: [] }) + '\n';

function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'externals-stdin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir, cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: dir },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function check(result, status, stdout, stderr) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
}

test('stdin matches file and literal dash paths in two foreign directories without mutating fixtures', t => {
  const dir = fixture(t);
  for (const name of ['one', 'two']) {
    const cwd = join(dir, name);
    mkdirSync(cwd);
    const path = join(cwd, 'report.json'), dash = join(cwd, '-');
    writeFileSync(path, source); writeFileSync(dash, source);
    check(run(dir, cwd, ['report.json'], ''), 0, expected, '');
    check(run(dir, cwd, ['./-'], ''), 0, expected, '');
    writeFileSync(dash, 'not the stdin report');
    check(run(dir, cwd, ['-'], source), 0, expected, '');
    check(run(dir, cwd, ['-'], source), 0, expected, '');
    assert.equal(readFileSync(path, 'utf8'), source);
    assert.equal(readFileSync(dash, 'utf8'), 'not the stdin report');
  }
});

test('stdin failures are atomic and argv takes precedence', t => {
  const dir = fixture(t), sentinel = 'SECRET_SENTINEL';
  for (const input of ['', ' \n\t', '{"entry":', '{} {}', sentinel]) {
    check(run(dir, dir, ['-'], input), 1, '', 'json\n');
  }
  check(run(dir, dir, ['-'], JSON.stringify({ sentinel })), 1, '', 'shape\n');
  for (const args of [[], ['-', 'extra']]) {
    check(run(dir, dir, args, sentinel), 1, '', 'argv\n');
  }
  check(run(dir, dir, ['missing'], sentinel), 1, '', 'read\n');
});
