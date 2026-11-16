import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();

function fixture(t) {
  const dir = mkdtempSync(join(scratch, 'import budget cli '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return result;
}

test('CLI rejects invalid arguments and missing entries without output files', (t) => {
  const dir = fixture(t);
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const missing = join(dir, 'missing.mjs');
  const cases = [
    { args: [], stderr: 'Usage: node import-budget.mjs <entry>\n' },
    { args: [missing, empty], stderr: 'Usage: node import-budget.mjs <entry>\n' },
    { args: [missing], stderr: 'Entry file not found\n' },
    { args: [empty], stderr: 'Entry file not found\n' },
  ];
  for (const { args, stderr } of cases) {
    const result = run(args, dir);
    assert.equal(result.status, 1, `args: ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, stderr);
    assert.deepEqual(readdirSync(dir), ['empty']);
    assert.deepEqual(readdirSync(empty), []);
  }
});

test('CLI emits deterministic JSON from an absolute path without executing or changing input', (t) => {
  const dir = fixture(t);
  const sourceDir = join(dir, 'source files');
  const cwd = join(dir, 'other cwd');
  mkdirSync(sourceDir);
  mkdirSync(cwd);
  const entry = join(sourceDir, 'entry file.mjs');
  const child = join(sourceDir, 'child file.mjs');
  const marker = join(sourceDir, 'executed');
  const source = `import './child file.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nthrow new Error('input executed');\n`;
  writeFileSync(entry, source);
  writeFileSync(child, 'export const value = 1;\n');
  const before = [readFileSync(entry), readFileSync(child)];
  const first = run([entry], cwd);
  const second = run([entry], cwd);
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /\n$/);
  const report = JSON.parse(first.stdout);
  assert.equal(first.stdout, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(report.entry, 'entry file.mjs');
  assert.deepEqual(report.modules.map((module) => module.path), ['child file.mjs', 'entry file.mjs']);
  assert.deepEqual(report.edges, [{ from: 'entry file.mjs', specifier: './child file.mjs', kind: 'eager', to: 'child file.mjs' }]);
  assert.equal(existsSync(marker), false);
  assert.deepEqual([readFileSync(entry), readFileSync(child)], before);
});
