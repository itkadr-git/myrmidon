import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const fixture = () => ({
  entry: 'entry.js',
  modules: [
    { path: 'entry.js', bytes: 2, eager: true },
    { path: 'a/eager.js', bytes: 3, eager: true },
    { path: 'a/lazy.js', bytes: 7, eager: false },
    { path: 'a/nested/empty.js', bytes: 0, eager: false },
    { path: 'disconnected/other.js', bytes: 11, eager: false },
  ],
  edges: [
    { from: 'entry.js', specifier: './a/eager.js', kind: 'eager', to: 'a/eager.js' },
    { from: 'entry.js', specifier: './a/lazy.js', kind: 'lazy', to: 'a/lazy.js' },
    { from: 'a/lazy.js', specifier: 'external', kind: 'lazy', to: null },
  ],
});

// Derive expected rows from the original modules, independently of the CLI output.
function oracle(report) {
  const groups = new Map();
  for (const module of report.modules) {
    const parts = module.path.split('/');
    parts.pop();
    const directory = parts.join('/') || '.';
    const group = groups.get(directory) || [];
    group.push(module);
    groups.set(directory, group);
  }
  const directories = [...groups.keys()].sort().map(directory => {
    const group = groups.get(directory);
    return {
      directory,
      modules: group.length,
      eagerModules: group.filter(module => module.eager).length,
      totalBytes: group.reduce((sum, module) => sum + module.bytes, 0),
      eagerBytes: group.filter(module => module.eager).reduce((sum, module) => sum + module.bytes, 0),
    };
  });
  return { entry: report.entry, directories };
}

function invoke(file, input, stdin) {
  return spawnSync(process.execPath, [cli, stdin ? '-' : file], {
    encoding: 'utf8', input: stdin ? input : undefined, timeout: 10000,
  });
}
function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function annotate(report, areas) {
  const extension = { extraNull: null, extraFlag: true, extraArray: [false, null, 'sentinel-14943'], extraObject: { nested: { value: 'sentinel-14943' } } };
  return {
    ...report,
    ...(areas.includes('report') ? extension : {}),
    modules: report.modules.map(module => ({ ...module, ...(areas.includes('modules') ? extension : {}) })),
    edges: report.edges.map(edge => ({ ...edge, ...(areas.includes('edges') ? extension : {}) })),
  };
}
function scratch(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'rollup-ext-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
}

test('producer extensions preserve exact rollup for file and stdin across permutations and repeats', t => {
  const file = scratch(t), base = fixture(), expected = oracle(base);
  assert.equal(expected.directories.length, 4);
  for (const areas of [[], ['report'], ['modules'], ['edges'], ['report', 'modules', 'edges']]) {
    for (const reverse of [false, true]) {
      const report = annotate(base, areas);
      if (reverse) { report.modules.reverse(); report.edges.reverse(); }
      const input = JSON.stringify(report);
      writeFileSync(file, input);
      for (const stdin of [false, true]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          assertOutput(invoke(file, input, stdin), expected);
          assert.equal(readFileSync(file, 'utf8'), input);
        }
      }
    }
  }
  const input = JSON.stringify(base);
  writeFileSync(file, input);
  const actual = invoke(file, input, false);
  const corrupt = structuredClone(expected);
  corrupt.directories[0].totalBytes++;
  assert.throws(() => assertOutput(actual, corrupt), assert.AssertionError);
  corrupt.directories.shift();
  assert.throws(() => assertOutput(actual, corrupt), assert.AssertionError);
});

test('extensions do not bypass shape or duplicate-edge validation', t => {
  const file = scratch(t);
  for (const [category, mutate] of [
    ['shape', report => { report.modules[0].bytes = -1; }],
    ['graph', report => { report.edges.push({ ...report.edges[0], anotherExtension: 'different' }); }],
  ]) {
    const report = annotate(fixture(), ['report', 'modules', 'edges']);
    mutate(report);
    const input = JSON.stringify(report);
    writeFileSync(file, input);
    for (const stdin of [false, true]) {
      const result = invoke(file, input, stdin);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, category + '\n');
      assert.equal(readFileSync(file, 'utf8'), input);
    }
  }
});
