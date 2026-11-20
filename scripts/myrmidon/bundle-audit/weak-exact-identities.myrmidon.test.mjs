import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.env.WEAK_IDENTITIES_TEST_CLI || join(here, 'import-report-weak-components.mjs');
const paths = ['__proto__', 'constructor', '10', '2', '"quoted"', 'back\\slash', 'line\nbreak', '\u00e9', '\ud83d\ude00', 'a/b|c', 'a:b,c', 'Z'];
const modules = paths.map((path, i) => ({ path, bytes: i + 1, eager: i % 2 === 0 }));
const edges = [
  { from: '__proto__', specifier: 'first', kind: 'eager', to: 'constructor' },
  { from: '__proto__', specifier: 'alias', kind: 'eager', to: 'constructor' },
  { from: 'constructor', specifier: 'numeric', kind: 'eager', to: '10' },
  { from: '2', specifier: 'quote', kind: 'eager', to: '"quoted"' },
  { from: '2', specifier: 'bridge', kind: 'lazy', to: '__proto__' },
  { from: 'back\\slash', specifier: 'line', kind: 'eager', to: 'line\nbreak' },
  { from: '\u00e9', specifier: 'unicode', kind: 'eager', to: '\ud83d\ude00' },
  { from: 'a/b|c', specifier: 'separator', kind: 'eager', to: 'a:b,c' },
];
const report = { entry: '__proto__', modules, edges };
// These literals are an independent oracle, not derived from graph traversal or sorting.
const eager = { entry: '__proto__', components: [
  { id: '"quoted"', paths: ['"quoted"', '2'], bytes: 9 },
  { id: '10', paths: ['10', '__proto__', 'constructor'], bytes: 6 },
  { id: 'Z', paths: ['Z'], bytes: 12 },
  { id: 'a/b|c', paths: ['a/b|c', 'a:b,c'], bytes: 21 },
  { id: 'back\\slash', paths: ['back\\slash', 'line\nbreak'], bytes: 13 },
  { id: '\u00e9', paths: ['\u00e9', '\ud83d\ude00'], bytes: 17 },
] };
const all = { entry: '__proto__', components: [
  { id: '"quoted"', paths: ['"quoted"', '10', '2', '__proto__', 'constructor'], bytes: 15 },
  ...eager.components.slice(2),
] };
const run = (value, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(value), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});

test('exact identities, code-unit ordering, aliases and fixed permutations', () => {
  const variants = [
    report,
    { ...report, modules: [...modules].reverse(), edges: [...edges].reverse() },
    { ...report, modules: [...modules.slice(5), ...modules.slice(0, 5)], edges: [...edges.slice(3), ...edges.slice(0, 3)] },
    { ...report, modules: modules.map(m => ({ ...m, eager: !m.eager })) },
  ];
  for (const [mode, expected] of [['eager', eager], ['all', all]]) {
    for (const value of variants) {
      const result = run(value, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(expected) + '\n', `${mode} exact stdout`);
    }
  }
});

test('empty path is invalid shape rather than an identity', () => {
  const result = run({ entry: '', modules: [{ path: '', bytes: 0, eager: false }], edges: [] }, 'all');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'shape\n');
});

test('negative control detects reversed component paths', { skip: !!process.env.WEAK_IDENTITIES_TEST_CLI }, () => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'weak-identities-'));
  try {
    const source = readFileSync(cli, 'utf8');
    assert.equal(source.split('paths.sort();').length, 2);
    const mutant = join(scratch, 'mutant.mjs');
    writeFileSync(mutant, source.replace('paths.sort();', 'paths.sort().reverse();'));
    const env = { ...process.env, WEAK_IDENTITIES_TEST_CLI: mutant };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: 'utf8', timeout: 30000, env,
    });
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stdout, /eager exact stdout/);
    assert.match(child.stdout, /AssertionError/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
