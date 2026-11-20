import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const modules = [
  { path: 'a', bytes: 2, eager: true },
  { path: 'A', bytes: 3, eager: true },
  { path: '__proto__', bytes: 5, eager: true },
  { path: 'constructor', bytes: 7, eager: true },
  { path: 'toString', bytes: 11, eager: false },
  { path: 'x|y', bytes: 13, eager: true },
  { path: 'x\ny', bytes: 17, eager: true },
  { path: 'x\u0000y', bytes: 19, eager: true },
  { path: '\u00e9', bytes: 23, eager: true },
  { path: '\ud83d\ude00', bytes: 29, eager: true },
];
const edges = [
  { from: 'A', to: 'a', kind: 'eager', specifier: 'one' },
  { from: 'a', to: 'A', kind: 'eager', specifier: 'two' },
  { from: 'A', to: '__proto__', kind: 'eager', specifier: 'x|y' },
  { from: 'a', to: '__proto__', kind: 'eager', specifier: 'x\ny' },
  { from: 'A', to: '__proto__', kind: 'lazy', specifier: 'x\u0000y' },
  { from: '__proto__', to: 'constructor', kind: 'eager', specifier: '\u00e9' },
  { from: 'constructor', to: 'toString', kind: 'eager', specifier: 'out' },
  { from: 'toString', to: 'constructor', kind: 'lazy', specifier: 'back' },
  { from: 'toString', to: 'toString', kind: 'eager', specifier: 'self' },
  { from: 'A', to: null, kind: 'eager', specifier: 'external' },
];
const report = { entry: 'a', modules, edges };

// These are derived from the graph above, not from the CLI output.
const eager = { entry: 'a', components: [
  { id: 'A', paths: ['A', 'a'], bytes: 5 },
  { id: '__proto__', paths: ['__proto__'], bytes: 5 },
  { id: 'constructor', paths: ['constructor'], bytes: 7 },
  { id: 'toString', paths: ['toString'], bytes: 11 },
  { id: 'x\u0000y', paths: ['x\u0000y'], bytes: 19 },
  { id: 'x\ny', paths: ['x\ny'], bytes: 17 },
  { id: 'x|y', paths: ['x|y'], bytes: 13 },
  { id: '\u00e9', paths: ['\u00e9'], bytes: 23 },
  { id: '\ud83d\ude00', paths: ['\ud83d\ude00'], bytes: 29 },
], edges: [
  { from: 'A', to: '__proto__' },
  { from: '__proto__', to: 'constructor' },
  { from: 'constructor', to: 'toString' },
] };
const all = { entry: 'a', components: [
  { id: 'A', paths: ['A', 'a'], bytes: 5 },
  { id: '__proto__', paths: ['__proto__'], bytes: 5 },
  { id: 'constructor', paths: ['constructor', 'toString'], bytes: 18 },
  { id: 'x\u0000y', paths: ['x\u0000y'], bytes: 19 },
  { id: 'x\ny', paths: ['x\ny'], bytes: 17 },
  { id: 'x|y', paths: ['x|y'], bytes: 13 },
  { id: '\u00e9', paths: ['\u00e9'], bytes: 23 },
  { id: '\ud83d\ude00', paths: ['\ud83d\ude00'], bytes: 29 },
], edges: [
  { from: 'A', to: '__proto__' },
  { from: '__proto__', to: 'constructor' },
] };

test('exact identities, byte sums, arc deduplication and ordering', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(root, 'condensation-identities-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const [mode, expected] of [['eager', eager], ['all', all]]) {
    const expectedStdout = `${JSON.stringify(expected)}\n`;
    for (const input of [report, { ...report, modules: [...modules].reverse(), edges: [...edges].reverse() }]) {
      const result = spawnSync(process.execPath, [cli, mode], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, TMPDIR: tmp },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expectedStdout);
      const corrupted = { ...expected, entry: 'wrong' };
      assert.throws(() => assert.equal(result.stdout, `${JSON.stringify(corrupted)}\n`), assert.AssertionError);
    }
  }
});
