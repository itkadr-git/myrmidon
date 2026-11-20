import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const sinks = join(dir, 'import-report-sinks.mjs');

test('sinks survive source root relocation and detect a new terminal', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'sinks-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  const sources = {
    'entry.mjs': "import './left.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'left.mjs': "import './end.mjs';\n",
    'right.mjs': "import './end.mjs';\n",
    'end.mjs': 'export const end = true;\n',
    'lazy.mjs': "import './lazy-end.mjs';\n",
    'lazy-end.mjs': 'export const lazy = true;\n',
  };
  mkdirSync(first, { recursive: true });
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(first, name), text);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = (root, names) => Object.fromEntries(names.map(name => [name, readFileSync(join(root, name), 'utf8')]));
  const names = Object.keys(sources);
  assert.deepEqual(snapshot(first, names), sources);
  assert.deepEqual(snapshot(second, names), sources);

  function run(script, args, input) {
    const result = spawnSync(process.execPath, [script, ...args], {
      input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TMPDIR: temp, RELOCATION_SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const json = JSON.parse(result.stdout);
    assert.equal(result.stdout, JSON.stringify(json, null, script === scanner ? 2 : undefined) + '\n');
    return result.stdout;
  }
  function scan(root, name) {
    const output = run(scanner, [join(root, 'entry.mjs')]);
    const path = join(temp, name);
    writeFileSync(path, output);
    return { path, output };
  }
  function analyze(report) {
    const output = run(sinks, [], readFileSync(report.path, 'utf8'));
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  function noRoots(...outputs) {
    for (const output of outputs) {
      assert.ok(!output.includes(first));
      assert.ok(!output.includes(second));
    }
  }
  const a = scan(first, 'first.json');
  const b = scan(second, 'second.json');
  assert.equal(a.output, b.output);
  const expected = JSON.stringify({ entry: 'entry.mjs', sinks: [{ path: 'end.mjs', bytes: 25 }], sinkBytes: 25 }) + '\n';
  const resultA = analyze(a);
  const resultB = analyze(b);
  assert.equal(resultA, expected);
  assert.equal(resultB, expected);
  noRoots(a.output, b.output, resultA, resultB);
  assert.deepEqual(snapshot(first, names), sources);
  assert.deepEqual(snapshot(second, names), sources);
  assert.equal(existsSync(sentinel), false);

  const terminal = 'export const terminal = true;\n';
  const changedEnd = sources['end.mjs'] + "import './terminal.mjs';\n";
  writeFileSync(join(second, 'end.mjs'), changedEnd);
  writeFileSync(join(second, 'terminal.mjs'), terminal);
  const control = scan(second, 'control.json');
  const changed = analyze(control);
  assert.equal(changed, JSON.stringify({ entry: 'entry.mjs', sinks: [{ path: 'terminal.mjs', bytes: 30 }], sinkBytes: 30 }) + '\n');
  assert.equal(analyze(a), expected);
  assert.equal(analyze(b), expected);
  noRoots(control.output, changed);
  assert.deepEqual(snapshot(first, names), sources);
  assert.deepEqual(snapshot(second, [...names, 'terminal.mjs']), { ...sources, 'end.mjs': changedEnd, 'terminal.mjs': terminal });
  assert.equal(existsSync(sentinel), false);
});
