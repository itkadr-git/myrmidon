import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `signal from ${script}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('scanner report drives cut impact without executing or modifying source, independent of cwd', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'cut-scanner-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'cut-scanner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceDir = join(dir, 'source');
  const unrelated = join(dir, 'unrelated');
  mkdirSync(sourceDir); mkdirSync(unrelated);
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\nimport('./lazyOnly.mjs');\n${guard}`,
    'a.mjs': `import './shared.mjs';\nimport './onlyA.mjs';\n${guard}`,
    'b.mjs': `import './shared.mjs';\n${guard}`,
    'shared.mjs': guard,
    'onlyA.mjs': `import './a.mjs';\n${guard}`,
    'lazyOnly.mjs': guard,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(sourceDir, name), text);
  const eager = ['a.mjs', 'b.mjs', 'entry.mjs', 'onlyA.mjs', 'shared.mjs'];
  const bytes = paths => paths.reduce((total, path) => total + Buffer.byteLength(sources[path]), 0);
  const cases = [
    ['a.mjs', ['a.mjs', 'onlyA.mjs']],
    ['entry.mjs', eager],
    ['lazyOnly.mjs', []],
  ];
  for (const cwd of [sourceDir, unrelated]) {
    const report = run(scanner, [join(sourceDir, 'entry.mjs')], cwd);
    for (const [removed, lostPaths] of cases) {
      const actual = run(consumer, [removed], cwd, JSON.stringify(report));
      assert.deepEqual(actual, { entry: 'entry.mjs', removed, lostPaths, lostBytes: bytes(lostPaths) });
    }
    for (const [name, text] of Object.entries(sources)) assert.equal(readFileSync(join(sourceDir, name), 'utf8'), text, name);
    assert.equal(existsSync(sentinel), false, 'source must never execute');
  }
});
