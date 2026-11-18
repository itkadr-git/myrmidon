import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const common = { from: 'entry', specifier: 'common', kind: 'eager', to: 'eager' };
const removed = { from: 'entry', specifier: 'old', kind: 'lazy', to: null };
const added = { from: 'eager', specifier: 'new', kind: 'lazy', to: 'lazy' };
const report = edges => ({ entry: 'entry', modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'eager', bytes: 2, eager: true }, { path: 'lazy', bytes: 3, eager: false }], edges });
const base = report([common, removed]);
const current = report([common, added]);
const output = (add, remove) => `${JSON.stringify({ entry: 'entry', added: add, removed: remove }, null, 2)}\n`;

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-stdin-'));
  const dirs = [join(root, 'cwd one'), join(root, 'cwd two')];
  for (const dir of dirs) mkdirSync(dir);
  const files = [join(root, 'base.json'), join(root, 'current.json')];
  const contents = [JSON.stringify(base), JSON.stringify(current)];
  files.forEach((file, i) => writeFileSync(file, contents[i]));
  t.after(() => { try { files.forEach((file, i) => assert.equal(readFileSync(file, 'utf8'), contents[i])); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { root, dirs, base: files[0], current: files[1] };
}
function run(f, cwd, args, input = '') {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, TMPDIR: f.root }, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function check(result, status, stdout, stderr) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
}

test('stdin on either side matches files and reverses exact edge changes', t => {
  const f = fixture(t);
  for (const cwd of f.dirs) {
    check(run(f, cwd, [f.base, f.current]), 0, output([added], [removed]), '');
    check(run(f, cwd, ['-', f.current], JSON.stringify(base)), 0, output([added], [removed]), '');
    check(run(f, cwd, [f.current, '-'], JSON.stringify(base)), 0, output([removed], [added]), '');
    writeFileSync(join(cwd, '-'), JSON.stringify(base));
    try {
      check(run(f, cwd, ['./-', f.current]), 0, output([added], [removed]), '');
      assert.equal(readFileSync(join(cwd, '-'), 'utf8'), JSON.stringify(base));
    } finally { rmSync(join(cwd, '-')); }
  }
});

test('invalid JSON and validation categories are preserved on either side', t => {
  const f = fixture(t);
  const invalids = [
    ['', 'invalid json or file'], ['  \n ', 'invalid json or file'], ['{"entry":', 'invalid json or file'], ['{} {}', 'invalid json or file'],
    ['{}', 'invalid report'],
    [JSON.stringify({ ...base, modules: [{ path: 'entry', bytes: -1, eager: true }] }), 'invalid module'],
    [JSON.stringify({ ...base, edges: [common, { ...removed, to: 'missing' }] }), 'dangling edge'],
    [JSON.stringify({ ...base, modules: base.modules.map(m => ({ ...m, eager: true })) }), 'invalid eager closure'],
    [JSON.stringify({ entry: 'other', modules: [{ path: 'other', bytes: 1, eager: true }], edges: [] }), 'entry mismatch'],
  ];
  for (const cwd of f.dirs) for (const [input, category] of invalids) {
    check(run(f, cwd, ['-', f.current], input), 1, '', `${category}\n`);
    check(run(f, cwd, [f.current, '-'], input), 1, '', `${category}\n`);
  }
});

test('invalid arguments take precedence over stdin', t => {
  const f = fixture(t);
  for (const cwd of f.dirs) for (const args of [['-', '-'], [], ['-'], ['-', f.current, 'extra']]) {
    check(run(f, cwd, args, '{'), 1, '', 'invalid arguments\n');
  }
});

test('rejects two stdin operands without waiting for EOF', async t => {
  const f = fixture(t);
  for (const cwd of f.dirs) {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [cli, '-', '-'], { cwd, env: { ...process.env, TMPDIR: f.root }, timeout: 10000 });
      let stdout = '';
      let stderr = '';
      let error;
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', err => { error = err; });
      child.on('close', (status, signal) => resolve({ error, status, signal, stdout, stderr }));
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    check(result, 1, '', 'invalid arguments\n');
  }
});
