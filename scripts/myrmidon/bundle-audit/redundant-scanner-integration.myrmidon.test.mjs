import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.REDUNDANT_CONSUMER || fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.trim());
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

function fixture(t, files) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'redundant-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source + guard);
  return { dir, sentinel, guard };
}

function pipeline(dir, sentinel) {
  const report = run(scanner, [join(dir, 'entry.mjs')]);
  assert.equal(existsSync(sentinel), false, 'scanner must not execute fixtures');
  const result = run(consumer, [], report.raw);
  assert.equal(existsSync(sentinel), false, 'consumer must not execute fixtures');
  return { report: report.json, result: result.json };
}

test('scanner triangle has the original shortcut and loses it after removing the detour', t => {
  const { dir, sentinel, guard } = fixture(t, {
    'entry.mjs': "import './mid.mjs';\nimport './leaf.mjs';\n",
    'mid.mjs': "import './leaf.mjs';\n",
    'leaf.mjs': '',
  });
  const before = pipeline(dir, sentinel);
  assert.deepEqual(before.report.edges, [
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './mid.mjs', kind: 'eager', to: 'mid.mjs' },
    { from: 'mid.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
  ]);
  assert.deepEqual(before.result, { entry: 'entry.mjs', redundant: [
    { from: 'entry.mjs', specifier: './leaf.mjs', to: 'leaf.mjs', alternativePath: ['entry.mjs', 'mid.mjs', 'leaf.mjs'] },
  ] });
  writeFileSync(join(dir, 'mid.mjs'), guard);
  const after = pipeline(dir, sentinel);
  assert.deepEqual(after.report.edges, [
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './mid.mjs', kind: 'eager', to: 'mid.mjs' },
  ]);
  assert.deepEqual(after.result, { entry: 'entry.mjs', redundant: [] });
});

test('resolved aliases are distinct edge tuples and independent alternatives', t => {
  const { dir, sentinel } = fixture(t, {
    'entry.mjs': "import './leaf';\nimport './leaf.mjs';\n",
    'leaf.mjs': '',
  });
  const { report, result } = pipeline(dir, sentinel);
  assert.deepEqual(report.edges, [
    { from: 'entry.mjs', specifier: './leaf', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
  ]);
  assert.deepEqual(result, { entry: 'entry.mjs', redundant: [
    { from: 'entry.mjs', specifier: './leaf', to: 'leaf.mjs', alternativePath: ['entry.mjs', 'leaf.mjs'] },
    { from: 'entry.mjs', specifier: './leaf.mjs', to: 'leaf.mjs', alternativePath: ['entry.mjs', 'leaf.mjs'] },
  ] });
});

test('lazy and external edges cannot create an eager detour', t => {
  const { dir, sentinel } = fixture(t, {
    'entry.mjs': "import './mid.mjs';\nimport './leaf.mjs';\nimport 'external-package';\n",
    'mid.mjs': "import('./leaf.mjs');\nimport 'external-package';\n",
    'leaf.mjs': '',
  });
  const { report, result } = pipeline(dir, sentinel);
  assert.deepEqual(report.edges, [
    { from: 'entry.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' },
    { from: 'entry.mjs', specifier: './mid.mjs', kind: 'eager', to: 'mid.mjs' },
    { from: 'entry.mjs', specifier: 'external-package', kind: 'eager', to: null },
    { from: 'mid.mjs', specifier: './leaf.mjs', kind: 'lazy', to: 'leaf.mjs' },
    { from: 'mid.mjs', specifier: 'external-package', kind: 'eager', to: null },
  ]);
  assert.deepEqual(result, { entry: 'entry.mjs', redundant: [] });
});
