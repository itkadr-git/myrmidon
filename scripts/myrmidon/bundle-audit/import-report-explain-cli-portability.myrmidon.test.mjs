import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-explain.mjs');
const sentinel = 'PORTABILITY_SENTINEL_927f6a';
const target = 'target with spaces # (x)';
const report = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: target, bytes: 1, eager: true },
    { path: 'lazy', bytes: 1, eager: false },
  ],
  edges: [
    { from: 'entry', to: target, kind: 'eager', specifier: target },
    { from: 'entry', to: 'lazy', kind: 'lazy', specifier: 'lazy' },
    { from: 'entry', to: null, kind: 'eager', specifier: sentinel },
  ],
};
const expected = JSON.stringify({ entry: 'entry', target, reachable: true, path: ['entry', target] }) + '\n';

function fixture(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(base, 'explain-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'cwd one'), cwd2 = join(root, 'cwd two');
  const files = join(root, `files ${sentinel} # (тест)`);
  for (const path of [cwd1, cwd2, files]) mkdirSync(path);
  return { root, cwd1, cwd2, files };
}
function run(root, cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: root },
  });
}
function common(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
}
function success(result) {
  common(result, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}
function failure(result, category, root, input) {
  common(result, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `error: ${category}\n`);
  for (const secret of [sentinel, root, input, '    at ']) assert.equal(result.stderr.includes(secret), false);
}

test('foreign working directories preserve argv, path bytes and fixtures', t => {
  const { root, cwd1, cwd2, files } = fixture(t);
  const input = JSON.stringify(report);
  const path = join(files, 'report # (данные).json');
  const ordinary = join(root, 'ordinary.json');
  const dash = join(cwd1, '-report.json');
  const sidecar = join(files, 'sentinel.txt');
  for (const file of [path, ordinary, dash]) writeFileSync(file, input);
  writeFileSync(sidecar, sentinel);
  const before = readdirSync(files).sort();
  success(run(root, cwd1, [ordinary, target]));
  for (const cwd of [cwd1, cwd2]) {
    for (const name of [path, relative(cwd, path)]) {
      success(run(root, cwd, [name, target]));
      success(run(root, cwd, [name, target]));
    }
  }
  success(run(root, cwd1, ['./-report.json', target]));
  for (const file of [path, ordinary, dash]) assert.equal(readFileSync(file, 'utf8'), input);
  assert.equal(readFileSync(sidecar, 'utf8'), sentinel);
  assert.deepEqual(readdirSync(files).sort(), before);
});

test('foreign cwd failures are atomic and expose only the exact category', t => {
  const { root, cwd1, cwd2, files } = fixture(t);
  const input = JSON.stringify(report);
  const valid = join(files, `${sentinel}.json`);
  const broken = join(files, 'broken.json');
  const invalid = join(files, 'invalid.json');
  writeFileSync(valid, input);
  writeFileSync(broken, `{ "${sentinel}": `);
  writeFileSync(invalid, JSON.stringify({ sentinel }));
  const cases = [
    [[], 'arguments'], [[valid], 'arguments'], [[valid, target, sentinel], 'arguments'],
    [[join(files, 'missing.json'), target], 'read'], [[files, target], 'read'],
    [[broken, target], 'json'], [[invalid, target], 'report'], [[valid, sentinel], 'target'],
  ];
  for (const cwd of [cwd1, cwd2]) {
    for (const [args, category] of cases) failure(run(root, cwd, args), category, root, input);
  }
});
