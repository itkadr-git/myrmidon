import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const target = 'target module # (data)';
const report = {
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: target, bytes: 2, eager: true }, { path: 'lazy', bytes: 3, eager: false }],
  edges: [
    { from: 'entry', to: target, kind: 'eager', specifier: './target' },
    { from: 'entry', to: 'lazy', kind: 'lazy', specifier: './lazy' },
    { from: 'entry', to: null, kind: 'lazy', specifier: 'unresolved' },
  ],
};
const expected = `${JSON.stringify({ entry: 'entry', target, importers: [{ path: 'entry', distance: 1 }] })}\n`;

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-cli-sentinel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'cwd one'), cwd2 = join(root, 'cwd two');
  const dir = join(root, 'report # (\u0414\u0430\u043d\u043d\u044b\u0435)');
  for (const path of [cwd1, cwd2, dir]) mkdirSync(path);
  const file = join(dir, 'report.json');
  const dash = join(cwd1, '-report.json');
  const sentinel = join(dir, 'sidecar.sentinel');
  const input = Buffer.from(JSON.stringify(report));
  writeFileSync(file, input);
  writeFileSync(dash, input);
  writeFileSync(sentinel, 'unchanged sentinel bytes\n');
  return { root, cwd1, cwd2, dir, file, dash, sentinel, input };
}

function run(cwd, args, root) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 5000, env: { ...process.env, TMPDIR: root },
  });
}

function status(result, code) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, code, result.stderr);
}

test('foreign working directories preserve paths, argv, output and input bytes', t => {
  const f = fixture(t);
  const before = readdirSync(f.dir).sort();
  const sidecar = readFileSync(f.sentinel);
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const path of [f.file, relative(cwd, f.file)]) {
      for (let i = 0; i < 2; i++) {
        const result = run(cwd, [path, target], f.root);
        status(result, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, expected);
      }
    }
  }
  const dash = run(f.cwd1, ['./-report.json', target], f.root);
  status(dash, 0);
  assert.equal(dash.stderr, '');
  assert.equal(dash.stdout, expected);
  assert.deepEqual(readFileSync(f.file), f.input);
  assert.deepEqual(readFileSync(f.dash), f.input);
  assert.deepEqual(readdirSync(f.dir).sort(), before);
  assert.deepEqual(readFileSync(f.sentinel), sidecar);
});

test('foreign cwd failures are atomic and disclose no input', t => {
  const f = fixture(t);
  const marker = 'unique-nonsecret-sentinel-7e92';
  const badJson = join(f.dir, `${marker}-bad.json`);
  const badShape = join(f.dir, `${marker}-shape.json`);
  const badText = `{"${marker}":`;
  const shapeText = JSON.stringify({ marker });
  writeFileSync(badJson, badText);
  writeFileSync(badShape, shapeText);
  const cases = [
    ['argv', []],
    ['argv', [f.file]],
    ['argv', [f.file, target, marker]],
    ['file', [join(f.dir, `${marker}-missing.json`), target]],
    ['file', [f.dir, target]],
    ['json', [badJson, target]],
    ['shape', [badShape, target]],
    ['graph', [f.file, marker]],
  ];
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const [category, args] of cases) {
      const result = run(cwd, args, f.root);
      status(result, 1);
      assert.equal(result.stdout, '', category);
      assert.equal(result.stderr, `${category}\n`);
      for (const secret of [marker, f.root, badText, shapeText, '    at ']) {
        assert.equal(result.stderr.includes(secret), false);
      }
    }
  }
});
