import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const run = file => spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 10000 });
const scratch = t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'conservation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
};

// The directory membership is specified in the fixture, not inferred from paths.
const groups = [
  ['.', ['entry.js', 'root.js']],
  ['a', ['a/one.js', 'a/two.js']],
  ['ab', ['ab/one.js', 'ab/two.js']],
  ['a/deep/leaf', ['a/deep/leaf/one.js', 'a/deep/leaf/two.js']],
  ['\u00e9', ['\u00e9/one.js', '\u00e9/two.js']],
  ['\u4e2d', ['\u4e2d/one.js']],
  ['Z', ['Z/one.js']],
];

function scenario(seed) {
  const rows = groups.map(([directory, paths], groupIndex) => ({
    directory,
    files: paths.map((path, index) => ({
      path,
      bytes: (seed + groupIndex * 7 + index * 3) % 11,
      eager: path === 'entry.js' || (seed + groupIndex + index) % 3 === 0,
    })),
  }));
  const modules = rows.flatMap(row => row.files);
  const edges = modules.filter(m => m.eager && m.path !== 'entry.js').map(m => ({
    from: 'entry.js', specifier: m.path, kind: 'eager', to: m.path,
  }));
  const lazy = modules.find(m => !m.eager);
  if (lazy) edges.push({ from: 'entry.js', specifier: lazy.path, kind: 'lazy', to: lazy.path });
  const directories = rows.map(({ directory, files }) => ({
    directory,
    modules: files.length,
    eagerModules: files.filter(file => file.eager).length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    eagerBytes: files.filter(file => file.eager).reduce((sum, file) => sum + file.bytes, 0),
  })).sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);
  return { report: { entry: 'entry.js', modules, edges }, expected: { entry: 'entry.js', directories } };
}

test('conserves each explicit directory group across 24 fixture sets and permutations', t => {
  const file = scratch(t);
  for (let seed = 0; seed < 24; seed++) {
    const { report, expected } = scenario(seed);
    for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
      writeFileSync(file, JSON.stringify(input));
      const result = run(file);
      assert.equal(result.status, 0, `seed ${seed}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(expected) + '\n', `seed ${seed}`);
    }
  }
});

test('safe integer boundary succeeds and per-directory overflow fails closed', t => {
  const file = scratch(t);
  const report = { entry: 'entry.js', modules: [
    { path: 'entry.js', bytes: 1, eager: true },
    { path: 'a/max.js', bytes: Number.MAX_SAFE_INTEGER, eager: false },
    { path: 'a/zero.js', bytes: 0, eager: false },
    { path: 'ab/other.js', bytes: 1, eager: false },
  ], edges: [] };
  writeFileSync(file, JSON.stringify(report));
  const ok = run(file);
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  assert.equal(ok.stdout, JSON.stringify({ entry: 'entry.js', directories: [
    { directory: '.', modules: 1, eagerModules: 1, totalBytes: 1, eagerBytes: 1 },
    { directory: 'a', modules: 2, eagerModules: 0, totalBytes: Number.MAX_SAFE_INTEGER, eagerBytes: 0 },
    { directory: 'ab', modules: 1, eagerModules: 0, totalBytes: 1, eagerBytes: 0 },
  ] }) + '\n');
  report.modules[2].bytes = 1;
  writeFileSync(file, JSON.stringify(report));
  const overflow = run(file);
  assert.equal(overflow.status, 1);
  assert.equal(overflow.stdout, '');
  assert.equal(overflow.stderr, 'graph\n');
});
