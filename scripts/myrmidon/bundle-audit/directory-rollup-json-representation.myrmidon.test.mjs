import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const fixture = {
  entry: 'entry.js',
  modules: [
    { path: 'entry.js', bytes: 2, eager: true },
    { path: 'nested/eager.js', bytes: 2, eager: true },
    { path: 'nested/zero.js', bytes: 0, eager: true },
    { path: '\u00e9/\ud83d\ude80.js', bytes: 2, eager: true },
    { path: 'lazy/item.js', bytes: 2, eager: false },
    { path: 'isolated/item.js', bytes: 2, eager: false },
  ],
  edges: [
    { from: 'entry.js', specifier: './nested/eager.js', kind: 'eager', to: 'nested/eager.js' },
    { from: 'nested/eager.js', specifier: './zero.js', kind: 'eager', to: 'nested/zero.js' },
    { from: 'entry.js', specifier: './unicode', kind: 'eager', to: '\u00e9/\ud83d\ude80.js' },
    { from: 'entry.js', specifier: './lazy/item.js', kind: 'lazy', to: 'lazy/item.js' },
  ],
};
const expected = JSON.stringify({ entry: 'entry.js', directories: [
  { directory: '.', modules: 1, eagerModules: 1, totalBytes: 2, eagerBytes: 2 },
  { directory: 'isolated', modules: 1, eagerModules: 0, totalBytes: 2, eagerBytes: 0 },
  { directory: 'lazy', modules: 1, eagerModules: 0, totalBytes: 2, eagerBytes: 0 },
  { directory: 'nested', modules: 2, eagerModules: 2, totalBytes: 2, eagerBytes: 2 },
  { directory: '\u00e9', modules: 1, eagerModules: 1, totalBytes: 2, eagerBytes: 2 },
] }) + '\n';

const run = (arg, input) => spawnSync(process.execPath, [cli, arg], { input, encoding: 'utf8', timeout: 10000 });
const check = (result, output) => {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, output);
};

test('equivalent JSON representations preserve exact directory rollup on file and stdin', t => {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(base, 'rollup-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const compact = JSON.stringify(fixture);
  const escaped = compact.replace('"entry":', '"\\u0065ntry":')
    .replaceAll('/', '\\/').replaceAll('\u00e9', '\\u00e9').replaceAll('\ud83d\ude80', '\\ud83d\\ude80');
  let index = 0;
  const numeric = compact.replace(/"bytes":2(?=[,}])/g, () => `"bytes":${['2', '2.0', '2e0'][index++ % 3]}`);
  const encodings = [compact, ` \t\r\n${JSON.stringify(fixture, null, 2).replaceAll('\n', '\r\n')}\r\n `, escaped, numeric, compact];
  for (const encoded of encodings) {
    assert.deepEqual(JSON.parse(encoded), fixture);
    const bytes = Buffer.from(encoded);
    writeFileSync(file, bytes);
    check(run(file), expected);
    assert.deepEqual(readFileSync(file), bytes);
    check(run('-', encoded), expected);
  }

  const changed = structuredClone(fixture);
  changed.modules[1].bytes = 3;
  const changedExpected = JSON.stringify({ entry: 'entry.js', directories: [
    { directory: '.', modules: 1, eagerModules: 1, totalBytes: 2, eagerBytes: 2 },
    { directory: 'isolated', modules: 1, eagerModules: 0, totalBytes: 2, eagerBytes: 0 },
    { directory: 'lazy', modules: 1, eagerModules: 0, totalBytes: 2, eagerBytes: 0 },
    { directory: 'nested', modules: 2, eagerModules: 2, totalBytes: 3, eagerBytes: 3 },
    { directory: '\u00e9', modules: 1, eagerModules: 1, totalBytes: 2, eagerBytes: 2 },
  ] }) + '\n';
  assert.notEqual(changedExpected, expected);
  check(run('-', JSON.stringify(changed)), changedExpected);
});

test('unescaped control character fails closed without reflecting input', t => {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(base, 'rollup-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const invalid = '{"entry":"LEAK_MARKER\u0001"}';
  writeFileSync(file, invalid);
  for (const result of [run(file), run('-', invalid)]) {
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'json\n');
    assert.ok(!result.stderr.includes('LEAK_MARKER'));
  }
  assert.deepEqual(readFileSync(file), Buffer.from(invalid));
});
