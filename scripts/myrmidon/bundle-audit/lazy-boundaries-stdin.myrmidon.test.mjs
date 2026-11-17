import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const report = {
  entry: 'entry.mjs',
  modules: [
    { path: 'entry.mjs', bytes: 10, eager: true },
    { path: 'eager.mjs', bytes: 20, eager: true },
    { path: 'lazy.mjs', bytes: 30, eager: false },
    { path: 'other.mjs', bytes: 40, eager: false },
  ],
  edges: [
    { from: 'entry.mjs', specifier: './eager', kind: 'eager', to: 'eager.mjs' },
    { from: 'eager.mjs', specifier: './lazy', kind: 'lazy', to: 'lazy.mjs' },
    { from: 'entry.mjs', specifier: './other', kind: 'lazy', to: 'other.mjs' },
    { from: 'lazy.mjs', specifier: './other', kind: 'lazy', to: 'other.mjs' },
    { from: 'entry.mjs', specifier: 'external', kind: 'lazy', to: null },
  ],
};
const expected = '{"entry":"entry.mjs","boundaries":[{"from":"eager.mjs","specifier":"./lazy","to":"lazy.mjs","bytes":30},{"from":"entry.mjs","specifier":"./other","to":"other.mjs","bytes":40}]}\n';

function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(item => {
    const path = join(dir, item.name);
    return item.isDirectory() ? [item.name, snapshot(path)] : [item.name, readFileSync(path).toString('base64')];
  });
}

test('stdin preserves the file protocol and fails closed across working directories', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'cwd one');
  const second = join(root, 'cwd two');
  const tmpdir = join(root, 'child tmp');
  for (const dir of [first, second, tmpdir]) mkdirSync(dir);
  const json = JSON.stringify(report) + ' \n\t';
  const inputFile = join(root, 'report.json');
  writeFileSync(inputFile, json);
  writeFileSync(join(first, '-'), json);
  writeFileSync(join(second, '-'), json);
  const before = snapshot(root);
  function invoke(cwd, args, input, status, stdout, stderr) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd, input, encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: tmpdir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, status);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, stderr);
    assert.deepEqual(snapshot(root), before);
  }
  for (const cwd of [first, second]) {
    invoke(cwd, [inputFile], '', 0, expected, '');
    invoke(cwd, ['./-'], 'not json', 0, expected, '');
    for (let i = 0; i < 2; i++) invoke(cwd, ['-'], json, 0, expected, '');
    for (const input of ['', ' \n\t', '{"entry":', '{} {}']) invoke(cwd, ['-'], input, 1, '', 'json\n');
    invoke(cwd, ['-'], JSON.stringify({ entry: 'entry.mjs' }), 1, '', 'shape\n');
    invoke(cwd, ['-'], JSON.stringify({ ...report, entry: 'missing.mjs' }), 1, '', 'graph\n');
    invoke(cwd, [], json, 1, '', 'argv\n');
    invoke(cwd, ['-', 'extra'], json, 1, '', 'argv\n');
    invoke(cwd, [join(root, 'missing.json')], json, 1, '', 'file\n');
  }
});
