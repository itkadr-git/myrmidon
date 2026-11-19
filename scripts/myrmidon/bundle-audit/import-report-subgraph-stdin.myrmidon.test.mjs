import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const report = { entry: 'a', modules: [
  {path:'a',bytes:1,eager:true}, {path:'b',bytes:2,eager:true}, {path:'c',bytes:3,eager:false},
], edges: [
  {from:'a',specifier:'b',kind:'eager',to:'b'}, {from:'a',specifier:'c',kind:'lazy',to:'c'},
] };
const json = JSON.stringify(report);
function setup(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(base, 'subgraph-stdin-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const first = join(root, 'first'), second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  for (const dir of [first, second]) {
    writeFileSync(join(dir, 'report.json'), json);
    writeFileSync(join(dir, '-'), json);
  }
  return {root, first, second};
}
function run(root, cwd, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, input, encoding:'utf8', timeout:10000, env:{...process.env, TMPDIR:root},
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category} error\n`);
}
test('stdin matches relative and literal dash files across cwd and repeats', t => {
  const {root, first, second} = setup(t);
  for (const cwd of [first, second]) {
    const file = run(root, cwd, ['report.json','a','eager'], '');
    assert.equal(file.status, 0); assert.equal(file.stderr, '');
    const dashFile = run(root, cwd, ['./-','a','eager'], 'sentinel');
    assert.equal(dashFile.status, 0); assert.equal(dashFile.stderr, ''); assert.equal(dashFile.stdout, file.stdout);
    for (const stdinCwd of [root, cwd]) {
      const stdin = run(root, stdinCwd, ['-','a','eager'], json + ' \n\t');
      assert.equal(stdin.status, 0); assert.equal(stdin.stderr, ''); assert.equal(stdin.stdout, file.stdout);
    }
    assert.equal(readFileSync(join(cwd, 'report.json'), 'utf8'), json);
    assert.equal(readFileSync(join(cwd, '-'), 'utf8'), json);
  }
});
test('stdin errors are atomic and argv validation precedes reading', t => {
  const {root, first} = setup(t);
  for (const input of ['', ' \n\t', '{"sentinel":', '{} {}']) failure(run(root, first, ['-','a','eager'], input), 'json');
  failure(run(root, first, ['-','a','eager'], '{"sentinel":true}'), 'shape');
  for (const args of [[], ['-'], ['-','a'], ['-','a','eager','extra'], ['-','a','bad']]) {
    failure(run(root, first, args, '{"sentinel":'), 'argv');
  }
  failure(run(root, first, ['missing','a','eager'], ''), 'read');
});
