import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const triangle = JSON.stringify({
  entry: 'e',
  modules: ['e', 'a', 'z'].map(path => ({ path, bytes: 0, eager: true })),
  edges: [
    { from: 'e', to: 'z', specifier: 'z', kind: 'eager' },
    { from: 'e', to: 'a', specifier: 'a', kind: 'eager' },
    { from: 'a', to: 'z', specifier: 'z', kind: 'eager' },
  ],
});
const expected = '{"entry":"e","redundant":[{"from":"e","specifier":"z","to":"z","alternativePath":["e","a","z"]}]}\n';

function setup(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(cwd, input, args = []) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding: 'utf8', shell: false, timeout: 5000,
    env: { ...process.env, TMPDIR: cwd },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test('stdin output is stable across working directories without file side effects', t => {
  const root = setup(t);
  const dirs = [join(root, 'plain'), join(root, 'space \u03bb ;$[x]')];
  for (const cwd of dirs) {
    mkdirSync(cwd);
    const sentinels = { 'report.json': Buffer.from('not the stdin report\n'), '-': Buffer.from([0, 255, 10]) };
    for (const [name, bytes] of Object.entries(sentinels)) writeFileSync(join(cwd, name), bytes);
    const listing = readdirSync(cwd).sort();
    for (let i = 0; i < 2; i++) {
      const result = run(cwd, triangle);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
      assert.deepEqual(readdirSync(cwd).sort(), listing);
      for (const [name, bytes] of Object.entries(sentinels)) assert.deepEqual(readFileSync(join(cwd, name)), bytes);
    }
  }
});

test('extra arguments take precedence over stdin parsing', t => {
  const cwd = setup(t);
  for (const input of [triangle, '', '{invalid']) {
    const result = run(cwd, input, ['unexpected']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'argv\n');
  }
});

test('empty and malformed stdin report json errors', t => {
  const cwd = setup(t);
  for (const input of ['', '{invalid']) {
    const result = run(cwd, input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'json\n');
  }
});
