import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const dominators = join(dir, 'import-report-dominators.mjs');
const target = 'sub/end.mjs';

test('dominator report survives source root relocation and detects a bypass', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'dominator-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  mkdirSync(join(first, 'sub'), { recursive: true });
  const sources = {
    'entry.mjs': "import './middle.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'middle.mjs': "import './left.mjs';\nimport './right.mjs';\n",
    'left.mjs': "import './sub/end.mjs';\n",
    'right.mjs': "import './sub/end.mjs';\n",
    'sub/end.mjs': 'export const end = true;\n',
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(first, name), text);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);

  function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TMPDIR: temp, RELOCATION_SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const value = JSON.parse(result.stdout);
    assert.equal(result.stdout, JSON.stringify(value, null, script === scanner ? 2 : undefined) + '\n');
    return result.stdout;
  }
  function scan(root, name) {
    const output = run(scanner, [join(root, 'entry.mjs')]);
    const path = join(temp, name);
    writeFileSync(path, output);
    return { path, output };
  }
  function analyze(report) {
    const output = run(dominators, [report.path, target]);
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  const a = scan(first, 'first-report.json');
  const b = scan(second, 'second-report.json');
  assert.equal(a.output, b.output);
  const expected = JSON.stringify({ entry: 'entry.mjs', target, dominators: ['entry.mjs', 'middle.mjs', 'sub/end.mjs'] }) + '\n';
  const resultA = analyze(a);
  const resultB = analyze(b);
  assert.equal(resultA, expected);
  assert.equal(resultB, expected);
  for (const output of [a.output, b.output, resultA, resultB]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  assert.equal(existsSync(sentinel), false);

  const changedEntry = sources['entry.mjs'] + "import './sub/end.mjs';\n";
  writeFileSync(join(second, 'entry.mjs'), changedEntry);
  const control = scan(second, 'control-report.json');
  const changed = analyze(control);
  assert.equal(changed, JSON.stringify({ entry: 'entry.mjs', target, dominators: ['entry.mjs', 'sub/end.mjs'] }) + '\n');
  assert.notEqual(changed, resultB);
  assert.equal(analyze(a), expected);
  assert.equal(readFileSync(b.path, 'utf8'), b.output);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'entry.mjs': changedEntry });
  assert.equal(existsSync(sentinel), false);
});
