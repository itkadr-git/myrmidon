import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const sentinel = 'SENTINEL_PRIVATE_REPORT_9482';
const report = {
  entry: 'entry.mjs',
  modules: [
    { path: 'entry.mjs', bytes: 10, eager: true },
    { path: 'source.mjs', bytes: 20, eager: true },
    { path: 'lazy.mjs', bytes: 30, eager: false },
  ],
  edges: [
    { from: 'entry.mjs', specifier: './source.mjs', kind: 'eager', to: 'source.mjs' },
    { from: 'source.mjs', specifier: './lazy.mjs', kind: 'lazy', to: 'lazy.mjs' },
    { from: 'entry.mjs', specifier: sentinel, kind: 'lazy', to: null },
  ],
};
const expected = '{"entry":"entry.mjs","boundaries":[{"from":"source.mjs","specifier":"./lazy.mjs","to":"lazy.mjs","bytes":30}]}\n';

function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [entry.name, snapshot(path)] : [entry.name, readFileSync(path).toString('base64')];
  });
}

function invoke(cwd, tmpdir, args, status, stdout, stderr, root) {
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env: { ...process.env, TMPDIR: tmpdir }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
  assert.deepEqual(snapshot(root), before);
}

test('CLI paths and fail-closed protocol are independent of cwd and read-only', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'cwd one # (\u96ea)');
  const second = join(root, 'cwd two # (\u03bb)');
  const inputs = join(root, 'input # (\u96ea)');
  const tmpdir = join(root, 'child tmp');
  for (const dir of [first, second, inputs, tmpdir]) mkdirSync(dir);
  const input = join(inputs, 'report # (\u03bb).json');
  const dash = join(second, '-report.json');
  writeFileSync(input, JSON.stringify(report));
  writeFileSync(dash, JSON.stringify(report));
  writeFileSync(join(inputs, 'sidecar.txt'), sentinel);
  const badJson = join(inputs, 'bad.json');
  const badShape = join(inputs, 'shape.json');
  const badGraph = join(inputs, 'graph.json');
  writeFileSync(badJson, `{${sentinel}`);
  writeFileSync(badShape, JSON.stringify({ entry: sentinel }));
  writeFileSync(badGraph, JSON.stringify({ ...report, entry: sentinel }));

  for (const cwd of [first, second]) {
    for (const arg of [input, relative(cwd, input)]) invoke(cwd, tmpdir, [arg], 0, expected, '', root);
    const failures = [
      [[], 'argv'], [[input, sentinel], 'argv'],
      [[join(inputs, sentinel)], 'file'], [[inputs], 'file'],
      [[badJson], 'json'], [[badShape], 'shape'], [[badGraph], 'graph'],
    ];
    for (const [args, category] of failures) invoke(cwd, tmpdir, args, 1, '', `${category}\n`, root);
  }
  invoke(second, tmpdir, ['./-report.json'], 0, expected, '', root);
});
