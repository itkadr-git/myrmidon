import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL';
const fixture = () => ({
  entry: 'entry.js',
  modules: [
    { path: 'entry.js', bytes: 2, eager: true },
    { path: 'dir/other.js', bytes: 3, eager: false },
  ],
  edges: [{ from: 'entry.js', specifier: sentinel, kind: 'lazy', to: null }],
});
const row = (directory, modules, eagerModules, totalBytes, eagerBytes) =>
  ({ directory, modules, eagerModules, totalBytes, eagerBytes });

function runner(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'rollup-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, `${sentinel}.json`);
  return report => {
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    return result;
  };
}

function rejected(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
  assert.ok(!result.stderr.includes(sentinel));
}

function accepted(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

test('path grammar rejects invalid module paths with the exact shape diagnostic', t => {
  const run = runner(t);
  for (const [name, path] of [
    ['empty', ''], ['absolute', '/absolute'], ['backslash', 'dir\\other.js'],
    ['dot segment', 'dir/./other.js'], ['parent segment', 'dir/../other.js'],
    ['repeated slash', 'dir//other.js'], ['trailing slash', 'dir/'],
  ]) {
    const report = fixture();
    report.modules[1].path = path;
    assert.doesNotThrow(() => rejected(run(report), 'shape'), name);
  }
});

test('dot-prefixed names are valid paths', t => {
  const run = runner(t);
  for (const [path, directory] of [['.hidden', '.'], ['..suffix/file.js', '..suffix']]) {
    const report = fixture();
    report.modules[1].path = path;
    const directories = directory === '.'
      ? [row('.', 2, 1, 5, 2)]
      : [row('.', 1, 1, 2, 2), row('..suffix', 1, 0, 3, 0)];
    accepted(run(report), { entry: 'entry.js', directories });
  }
});

test('directory sums use safe integers per directory', t => {
  const run = runner(t);
  const base = {
    entry: 'dir/entry.js',
    modules: [
      { path: 'dir/entry.js', bytes: Number.MAX_SAFE_INTEGER - 2, eager: true },
      { path: 'dir/other.js', bytes: 2, eager: false },
    ],
    edges: [],
  };
  const overflow = structuredClone(base);
  overflow.modules[1].bytes = 3;
  const separate = structuredClone(overflow);
  separate.modules[1].path = 'other/other.js';
  const cases = [
    ['same directory at maximum', base, { entry: 'dir/entry.js', directories: [row('dir', 2, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 2)] }],
    ['different directories do not overflow globally', separate, { entry: 'dir/entry.js', directories: [row('dir', 1, 1, Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 2), row('other', 1, 0, 3, 0)] }],
  ];
  for (const [name, report, expected] of cases) {
    assert.doesNotThrow(() => accepted(run(report), expected), name);
  }
  rejected(run(overflow), 'graph');
});
