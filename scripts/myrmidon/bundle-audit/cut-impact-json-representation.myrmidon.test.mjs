import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'a', bytes: 2, eager: true },
    { path: 'b', bytes: 2, eager: true },
    { path: '\ud83d\ude80/join', bytes: 3, eager: true },
    { path: 'tail', bytes: 0, eager: true },
    { path: 'off', bytes: 7, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: 'a', kind: 'eager', to: 'a' },
    { from: 'entry', specifier: 'b', kind: 'eager', to: 'b' },
    { from: 'a', specifier: 'join', kind: 'eager', to: '\ud83d\ude80/join' },
    { from: 'b', specifier: 'join', kind: 'eager', to: '\ud83d\ude80/join' },
    { from: '\ud83d\ude80/join', specifier: 'tail', kind: 'eager', to: 'tail' },
  ],
};
const expected = [
  ['entry', '{"entry":"entry","removed":"entry","lostPaths":["a","b","entry","tail","\ud83d\ude80/join"],"lostBytes":8}\n'],
  ['a', '{"entry":"entry","removed":"a","lostPaths":["a"],"lostBytes":2}\n'],
  ['tail', '{"entry":"entry","removed":"tail","lostPaths":["tail"],"lostBytes":0}\n'],
  ['off', '{"entry":"entry","removed":"off","lostPaths":[],"lostBytes":0}\n'],
];

function run(input, removed) {
  return spawnSync(process.execPath, [cli, removed], { input, encoding: 'utf8', cwd: homedir(), timeout: 10000 });
}
function assertOutput(result, output) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, output);
}

test('equivalent JSON representations preserve diamond and tail cut impact', t => {
  const root = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'cut-impact-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const compact = JSON.stringify(fixture);
  const escaped = compact.replace('"entry":', '"\\u0065ntry":')
    .replaceAll('\ud83d\ude80/join', '\\ud83d\\ude80\\/join');
  const numeric = compact.replace('"bytes":2', '"bytes":2.0')
    .replace('"bytes":2,"eager"', '"bytes":2e0,"eager"');
  const representations = [compact, ` \t\r\n${JSON.stringify(fixture, null, 2).replaceAll('\n', '\r\n')}\r\n `, escaped, numeric, compact];
  assert.match(escaped, /\\u0065ntry/);
  assert.match(escaped, /\\ud83d\\ude80\\\/join/);
  assert.match(numeric, /"bytes":2\.0/);
  assert.match(numeric, /"bytes":2e0/);
  for (const [index, encoded] of representations.entries()) {
    assert.deepEqual(JSON.parse(encoded), fixture);
    const path = join(dir, `report-${index}.json`);
    writeFileSync(path, encoded);
    const before = readFileSync(path);
    for (const [removed, output] of expected) assertOutput(run(before, removed), output);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('changing the topology changes the concrete cut result', () => {
  const changed = { ...fixture, edges: fixture.edges.filter(edge => !(edge.from === 'b' && edge.to === '\ud83d\ude80/join')) };
  assertOutput(run(JSON.stringify(changed), 'a'), '{"entry":"entry","removed":"a","lostPaths":["a","tail","\ud83d\ude80/join"],"lostBytes":5}\n');
});

test('unescaped control characters fail closed without exposing input', () => {
  const marker = 'sensitive-marker';
  const result = run(`{"entry":"${marker}\u0001"}`, 'entry');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(marker), false);
});
