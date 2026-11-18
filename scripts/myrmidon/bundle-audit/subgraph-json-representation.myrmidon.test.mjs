import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const report = {
  entry: 'root/😀',
  modules: [
    { path: 'root/😀', bytes: 2, eager: true },
    { path: 'dep', bytes: 2, eager: true },
    { path: 'lazy', bytes: 2, eager: false },
  ],
  edges: [
    { from: 'root/😀', specifier: './dep', kind: 'eager', to: 'dep' },
    { from: 'root/😀', specifier: './lazy', kind: 'lazy', to: 'lazy' },
    { from: 'dep', specifier: './root', kind: 'eager', to: 'root/😀' },
    { from: 'dep', specifier: 'unknown', kind: 'eager', to: null },
  ],
};

// Explicit expected JSON includes preserved input object property order.
const eager = '{"root":"root/😀","mode":"eager","modules":[{"path":"dep","bytes":2,"eager":true},{"path":"root/😀","bytes":2,"eager":true}],"edges":[{"from":"dep","specifier":"./root","kind":"eager","to":"root/😀"},{"from":"dep","specifier":"unknown","kind":"eager","to":null},{"from":"root/😀","specifier":"./dep","kind":"eager","to":"dep"}],"unknown":[{"from":"dep","specifier":"unknown","kind":"eager","to":null}]}\n';
const all = '{"root":"root/😀","mode":"all","modules":[{"path":"dep","bytes":2,"eager":true},{"path":"lazy","bytes":2,"eager":false},{"path":"root/😀","bytes":2,"eager":true}],"edges":[{"from":"dep","specifier":"./root","kind":"eager","to":"root/😀"},{"from":"dep","specifier":"unknown","kind":"eager","to":null},{"from":"root/😀","specifier":"./dep","kind":"eager","to":"dep"},{"from":"root/😀","specifier":"./lazy","kind":"lazy","to":"lazy"}],"unknown":[{"from":"dep","specifier":"unknown","kind":"eager","to":null}]}\n';

function run(input, mode, file) {
  return spawnSync(process.execPath, [cli, file ?? '-', report.entry, mode], {
    encoding: 'utf8', input: file ? undefined : input, timeout: 10000,
  });
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

test('equivalent JSON representations preserve the subgraph over file and stdin', t => {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(base, 'subgraph-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const compact = JSON.stringify(report);
  const pretty = ' \t\r\n' + JSON.stringify(report, null, 2).replaceAll('\n', '\r\n') + '\r\n ';
  const escaped = compact.replaceAll('"entry"', '"\\u0065ntry"').replaceAll('/', '\\/').replaceAll('😀', '\\ud83d\\ude00').replaceAll('dep', '\\u0064ep');
  const numeric = compact.replace('"bytes":2', '"bytes":2.0').replace('"bytes":2,', '"bytes":2e0,');
  for (const encoded of [compact, pretty, escaped, numeric, compact]) {
    assert.deepEqual(JSON.parse(encoded), report);
    writeFileSync(file, encoded);
    const before = readFileSync(file);
    for (const [mode, expected] of [['eager', eager], ['all', all]]) {
      success(run(encoded, mode, file), expected);
      success(run(encoded, mode), expected);
    }
    assert.deepEqual(readFileSync(file), before);
  }
  const changed = structuredClone(report);
  changed.modules[1].bytes = 3;
  const changedExpected = eager.replace('"path":"dep","bytes":2', '"path":"dep","bytes":3');
  assert.notEqual(changedExpected, eager);
  success(run(JSON.stringify(changed), 'eager'), changedExpected);
});

test('invalid JSON control character fails closed without echoing input', t => {
  const base = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(base, 'subgraph-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const input = '{"marker":"SECRET_MARKER\u0001"}';
  writeFileSync(file, input);
  const before = readFileSync(file);
  for (const path of [file, undefined]) {
    const result = run(input, 'all', path);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'json error\n');
    assert.doesNotMatch(result.stderr, /SECRET_MARKER/);
  }
  assert.deepEqual(readFileSync(file), before);
});
