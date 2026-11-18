import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-condensation.mjs');

test('condensation survives source root relocation and detects an eager cycle', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'condensation-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  const sources = {
    'entry.mjs': "import './a.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'a.mjs': "import './b.mjs';\n",
    'b.mjs': "import './a.mjs';\nimport('./c.mjs');\n",
    'c.mjs': "import './a.mjs';\n",
  };
  mkdirSync(first, { recursive: true });
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(first, name), text);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);

  function run(script, args, input) {
    const result = spawnSync(process.execPath, [script, ...args], {
      input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TMPDIR: temp, RELOCATION_SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.stdout, JSON.stringify(parsed, null, script === scanner ? 2 : undefined) + '\n');
    return result.stdout;
  }
  function scan(root, name) {
    const output = run(scanner, [join(root, 'entry.mjs')]);
    const path = join(temp, name);
    writeFileSync(path, output);
    return { path, output };
  }
  function analyze(report, mode) {
    const output = run(consumer, [mode], readFileSync(report.path, 'utf8'));
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  const size = name => Buffer.byteLength(sources[name]);
  const entry = { id: 'entry.mjs', paths: ['entry.mjs'], bytes: size('entry.mjs') };
  const expectedEager = JSON.stringify({ entry: 'entry.mjs', components: [
    { id: 'a.mjs', paths: ['a.mjs', 'b.mjs'], bytes: size('a.mjs') + size('b.mjs') },
    { id: 'c.mjs', paths: ['c.mjs'], bytes: size('c.mjs') }, entry,
  ], edges: [{ from: 'c.mjs', to: 'a.mjs' }, { from: 'entry.mjs', to: 'a.mjs' }] }) + '\n';
  const expectedAll = bBytes => JSON.stringify({ entry: 'entry.mjs', components: [
    { id: 'a.mjs', paths: ['a.mjs', 'b.mjs', 'c.mjs'], bytes: size('a.mjs') + bBytes + size('c.mjs') }, entry,
  ], edges: [{ from: 'entry.mjs', to: 'a.mjs' }] }) + '\n';
  const a = scan(first, 'first.json');
  const b = scan(second, 'second.json');
  assert.equal(a.output, b.output);
  const outputs = [a.output, b.output];
  for (const report of [a, b]) {
    const eager = analyze(report, 'eager');
    const all = analyze(report, 'all');
    assert.equal(eager, expectedEager);
    assert.equal(all, expectedAll(size('b.mjs')));
    outputs.push(eager, all);
  }
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  assert.equal(existsSync(sentinel), false);

  const changedB = "import './a.mjs';\nimport './c.mjs';\n";
  writeFileSync(join(second, 'b.mjs'), changedB);
  const control = scan(second, 'control.json');
  const changedExpected = expectedAll(Buffer.byteLength(changedB));
  const changedEager = analyze(control, 'eager');
  const changedAll = analyze(control, 'all');
  assert.equal(changedEager, changedExpected);
  assert.equal(changedAll, changedExpected);
  assert.equal(analyze(a, 'eager'), expectedEager);
  assert.equal(analyze(a, 'all'), expectedAll(size('b.mjs')));
  assert.equal(readFileSync(b.path, 'utf8'), b.output);
  outputs.push(control.output, changedEager, changedAll);
  for (const output of outputs) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'b.mjs': changedB });
  assert.equal(existsSync(sentinel), false);
});
