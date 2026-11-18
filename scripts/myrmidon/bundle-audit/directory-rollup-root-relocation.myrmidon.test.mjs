import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const rollup = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const files = {
  'entry.mjs': 'import { writeFileSync } from "node:fs";\nimport "./a/eager.mjs";\nimport("./a/lazy.mjs");\nimport("./a/nested/lazy.mjs");\nwriteFileSync(process.env.SENTINEL, "executed");\n',
  'a/eager.mjs': 'import "./nested/eager.mjs";\nexport const a = 1;\n',
  'a/lazy.mjs': 'export const b = 2;\n',
  'a/nested/eager.mjs': 'export const c = 3;\n',
  'a/nested/lazy.mjs': 'export const d = 4;\n',
};
const changedLazy = 'export const b = 200;\n';
const expected = { entry: 'entry.mjs', directories: [
  { directory: '.', modules: 1, eagerModules: 1, totalBytes: 169, eagerBytes: 169 },
  { directory: 'a', modules: 2, eagerModules: 1, totalBytes: 69, eagerBytes: 49 },
  { directory: 'a/nested', modules: 2, eagerModules: 1, totalBytes: 40, eagerBytes: 20 },
] };
const changedExpected = { entry: 'entry.mjs', directories: [
  { directory: '.', modules: 1, eagerModules: 1, totalBytes: 169, eagerBytes: 169 },
  { directory: 'a', modules: 2, eagerModules: 1, totalBytes: 71, eagerBytes: 49 },
  { directory: 'a/nested', modules: 2, eagerModules: 1, totalBytes: 40, eagerBytes: 20 },
] };

test('directory rollup survives source-root relocation and detects a changed lazy module', t => {
  const parent = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const scratch = mkdtempSync(join(parent, 'directory-relocation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const first = join(scratch, 'first');
  const second = join(scratch, 'other depth', 'source \u00e9 tree');
  const sentinel = join(scratch, 'executed');
  for (const [name, source] of Object.entries(files)) {
    const path = join(first, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const checkSources = (root, contents) => {
    for (const [name, source] of Object.entries(contents)) assert.deepEqual(readFileSync(join(root, name)), Buffer.from(source));
  };
  const run = (script, args, input) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000, input,
      env: { ...process.env, TMPDIR: scratch, SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    return result.stdout;
  };
  const analyze = (root, reportName) => {
    const scan = run(scanner, [join(root, 'entry.mjs')]);
    const report = join(scratch, reportName);
    writeFileSync(report, scan);
    const output = run(rollup, [report]);
    assert.equal(readFileSync(report, 'utf8'), scan);
    for (const path of [first, second]) {
      assert.equal(scan.includes(path), false);
      assert.equal(output.includes(path), false);
    }
    assert.equal(existsSync(sentinel), false);
    return output;
  };
  checkSources(first, files);
  checkSources(second, files);
  const firstOutput = analyze(first, 'first.json');
  const secondOutput = analyze(second, 'second.json');
  assert.equal(firstOutput, JSON.stringify(expected) + '\n');
  assert.equal(secondOutput, firstOutput);
  checkSources(first, files);
  checkSources(second, files);

  writeFileSync(join(second, 'a/lazy.mjs'), changedLazy);
  const changedOutput = analyze(second, 'changed.json');
  assert.equal(changedOutput, JSON.stringify(changedExpected) + '\n');
  assert.notEqual(changedOutput, firstOutput);
  assert.equal(analyze(first, 'first-again.json'), firstOutput);
  checkSources(first, files);
  checkSources(second, { ...files, 'a/lazy.mjs': changedLazy });
});
