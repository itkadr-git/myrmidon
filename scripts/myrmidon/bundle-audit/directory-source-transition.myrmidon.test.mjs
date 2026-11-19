import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const beforeEntry = "import './old/shared.mjs';\nimport './old/move.mjs';\nimport('./lazy/only.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('sentinel', 'executed');\nthrow new Error('must not execute');\n// \u00e9\n";
const afterEntry = beforeEntry.replace('./old/shared.mjs', './new/nested/shared.mjs').replace('./old/move.mjs', './new/nested/move.mjs').replace("import('./lazy/only.mjs');", "import './lazy/only.mjs';");
const beforeShared = "import './move.mjs';\nexport const shared = 'shared';\n";
const afterShared = beforeShared;
const moved = "export const moved = 'a unique moved source';\n";
const lazy = "export const lazy = 'lazy source';\n";
const size = text => Buffer.byteLength(text);

function execute(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function expected(entry, shared, location, isLazy) {
  const modules = [
    { path: 'entry.mjs', bytes: size(entry), eager: true },
    { path: 'lazy/only.mjs', bytes: size(lazy), eager: !isLazy },
    { path: location, bytes: size(moved), eager: true },
    { path: location.replace('move.mjs', 'shared.mjs'), bytes: size(shared), eager: true },
  ];
  const edges = [
    { from: 'entry.mjs', specifier: './lazy/only.mjs', kind: isLazy ? 'lazy' : 'eager', to: 'lazy/only.mjs' },
    { from: 'entry.mjs', specifier: `./${location}`, kind: 'eager', to: location },
    { from: 'entry.mjs', specifier: `./${location.replace('move.mjs', 'shared.mjs')}`, kind: 'eager', to: location.replace('move.mjs', 'shared.mjs') },
    { from: location.replace('move.mjs', 'shared.mjs'), specifier: './move.mjs', kind: 'eager', to: location },
  ];
  const eagerBytes = size(entry) + size(shared) + size(moved) + (isLazy ? 0 : size(lazy));
  return {
    scan: { entry: 'entry.mjs', modules, edges, unknown: [], counts: { modules: 4, eagerModules: isLazy ? 3 : 4, edges: 4 },
      bytes: { total: size(entry) + size(shared) + size(moved) + size(lazy), eager: eagerBytes },
      heaviestEager: (isLazy ? [modules[0], modules[3], modules[2]] : [modules[0], modules[3], modules[2], modules[1]]) },
    rollup: { entry: 'entry.mjs', directories: [
      { directory: '.', modules: 1, eagerModules: 1, totalBytes: size(entry), eagerBytes: size(entry) },
      { directory: 'lazy', modules: 1, eagerModules: isLazy ? 0 : 1, totalBytes: size(lazy), eagerBytes: isLazy ? 0 : size(lazy) },
      { directory: location.slice(0, location.lastIndexOf('/')), modules: 2, eagerModules: 2, totalBytes: size(moved) + size(shared), eagerBytes: size(moved) + size(shared) },
    ] },
  };
}

test('rescans source transitions without executing fixtures or double-counting the diamond', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'old')); mkdirSync(join(dir, 'lazy')); mkdirSync(join(dir, 'new/nested'), { recursive: true });
  const put = (path, text) => writeFileSync(join(dir, path), text);
  put('entry.mjs', beforeEntry); put('old/shared.mjs', beforeShared); put('old/move.mjs', moved); put('lazy/only.mjs', lazy);
  const check = (entry, shared, location, isLazy, protocol) => {
    const expectedResult = expected(entry, shared, location, isLazy);
    const scan = execute(scanner, ['entry.mjs'], dir);
    assert.deepEqual(JSON.parse(scan), expectedResult.scan);
    const report = join(dir, 'report.json');
    writeFileSync(report, scan);
    const output = protocol === 'file' ? execute(consumer, [report], dir) : execute(consumer, ['-'], dir, scan);
    assert.deepEqual(JSON.parse(output), expectedResult.rollup);
    assert.equal(readFileSync(report, 'utf8'), scan);
    for (const [path, text] of [['entry.mjs', entry], [location.replace('move.mjs', 'shared.mjs'), shared], [location, moved], ['lazy/only.mjs', lazy]]) assert.equal(readFileSync(join(dir, path), 'utf8'), text);
    assert.equal(existsSync(join(dir, 'sentinel')), false);
  };
  check(beforeEntry, beforeShared, 'old/move.mjs', true, 'file');
  renameSync(join(dir, 'old/move.mjs'), join(dir, 'new/nested/move.mjs'));
  renameSync(join(dir, 'old/shared.mjs'), join(dir, 'new/nested/shared.mjs'));
  put('entry.mjs', afterEntry);
  check(afterEntry, afterShared, 'new/nested/move.mjs', false, 'stdin');
  check(afterEntry, afterShared, 'new/nested/move.mjs', false, 'file');
});
