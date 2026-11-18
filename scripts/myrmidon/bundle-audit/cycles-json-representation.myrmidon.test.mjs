import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-cycles.mjs', import.meta.url));
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
const fixture = {
  entry: 'a/\u{1f680}',
  modules: [
    { path: 'b', bytes: 2, eager: true },
    { path: 'a/\u{1f680}', bytes: 2, eager: true },
    { path: 'd', bytes: 2, eager: false },
    { path: 'c', bytes: 2, eager: false },
    { path: 'leaf', bytes: 2, eager: false },
  ],
  edges: [
    { from: 'a/\u{1f680}', to: 'b', kind: 'eager', specifier: './b' },
    { from: 'b', to: 'a/\u{1f680}', kind: 'eager', specifier: './a' },
    { from: 'c', to: 'd', kind: 'lazy', specifier: './d' },
    { from: 'd', to: 'c', kind: 'lazy', specifier: './c' },
  ],
};
const expected = '{"entry":"a/\u{1f680}","eagerCycles":[["a/\u{1f680}","b"]],"allCycles":[["a/\u{1f680}","b"],["c","d"]]}\n';
const changedExpected = '{"entry":"a/\u{1f680}","eagerCycles":[],"allCycles":[["c","d"]]}\n';

function run(input, file, expectedOutput) {
  writeFileSync(file, input);
  const bytes = readFileSync(file);
  for (const transport of ['file', 'stdin']) {
    const result = spawnSync(process.execPath, [cli, transport === 'file' ? file : '-'], {
      input: transport === 'stdin' ? input : undefined, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.signal, null, transport);
    assert.equal(result.status, 0, `${transport}: ${result.stderr}`);
    assert.equal(result.stderr, '', transport);
    assert.equal(result.stdout, expectedOutput, transport);
    assert.deepEqual(readFileSync(file), bytes, transport);
  }
}

test('equivalent JSON representations preserve exact cycle results on file and stdin', t => {
  const dir = mkdtempSync(join(scratch, 'cycles-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const compact = JSON.stringify(fixture);
  const pretty = ' \t\r\n' + JSON.stringify(fixture, null, 2).replaceAll('\n', '\r\n') + '\r\n \t';
  const escaped = compact.replace('"entry"', '"\\u0065ntry"')
    .replaceAll('a/\u{1f680}', 'a\\/\\ud83d\\ude80')
    .replace('"modules"', '"\\u006dodules"');
  let numberIndex = 0;
  const numbers = compact.replaceAll('"bytes":2', () => `"bytes":${['2', '2.0', '2e0'][numberIndex++ % 3]}`);
  assert.match(escaped, /\\u0065ntry/);
  assert.match(escaped, /\\\/\\ud83d\\ude80/);
  assert.match(numbers, /"bytes":2\.0/);
  assert.match(numbers, /"bytes":2e0/);
  for (const input of [compact, pretty, escaped, numbers, compact]) {
    assert.deepEqual(JSON.parse(input), fixture);
    run(input, file, expected);
  }
  const changed = structuredClone(fixture);
  changed.edges.splice(1, 1);
  assert.notEqual(changedExpected, expected);
  run(JSON.stringify(changed), file, changedExpected);
});

test('invalid unescaped control character fails closed on file and stdin', t => {
  const dir = mkdtempSync(join(scratch, 'cycles-json-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const marker = 'SECRET_MARKER';
  const input = `{"entry":"${marker}\u0001"}`;
  writeFileSync(file, input);
  const bytes = readFileSync(file);
  for (const transport of ['file', 'stdin']) {
    const result = spawnSync(process.execPath, [cli, transport === 'file' ? file : '-'], {
      input: transport === 'stdin' ? input : undefined, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(marker), false);
    assert.deepEqual(readFileSync(file), bytes);
  }
});
