import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const fanOut = join(dir, 'import-report-fan-out.mjs');

test('fan-out remains exact across relocated source trees and detects a new eager edge', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'fan-out-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  const sources = {
    'entry.mjs': "import './a.mjs';\nimport './b.mjs';\nimport './missing-package';\nimport('bare-package');\nimport('./lazy.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'a.mjs': "import './shared.mjs';\nimport './shared';\n",
    'b.mjs': "import './shared.mjs';\n",
    'shared.mjs': 'export const shared = true;\n',
    'lazy.mjs': 'export const lazy = true;\n',
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
    const output = run(fanOut, [], readFileSync(report.path, 'utf8'));
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  const bytes = name => Buffer.byteLength(sources[name]);
  const expected = {
    entry: 'entry.mjs',
    modules: [
      { path: 'entry.mjs', bytes: bytes('entry.mjs'), targets: ['a.mjs', 'b.mjs'], fanOut: 2 },
      { path: 'a.mjs', bytes: bytes('a.mjs'), targets: ['shared.mjs'], fanOut: 1 },
      { path: 'b.mjs', bytes: bytes('b.mjs'), targets: ['shared.mjs'], fanOut: 1 },
      { path: 'lazy.mjs', bytes: bytes('lazy.mjs'), targets: [], fanOut: 0 },
      { path: 'shared.mjs', bytes: bytes('shared.mjs'), targets: [], fanOut: 0 },
    ],
  };
  const a = scan(first, 'first.json');
  const b = scan(second, 'second.json');
  assert.equal(a.output, b.output);
  const resultA = analyze(a);
  const resultB = analyze(b);
  assert.equal(resultA, JSON.stringify(expected) + '\n');
  assert.equal(resultB, JSON.stringify(expected) + '\n');

  const changedA = sources['a.mjs'] + "import './b.mjs';\n";
  writeFileSync(join(second, 'a.mjs'), changedA);
  const control = scan(second, 'control.json');
  const changed = analyze(control);
  const expectedControl = {
    entry: 'entry.mjs',
    modules: [
      { path: 'a.mjs', bytes: Buffer.byteLength(changedA), targets: ['b.mjs', 'shared.mjs'], fanOut: 2 },
      expected.modules[0], expected.modules[2], expected.modules[3], expected.modules[4],
    ],
  };
  assert.equal(changed, JSON.stringify(expectedControl) + '\n');
  assert.equal(analyze(a), resultA);
  assert.equal(readFileSync(b.path, 'utf8'), b.output);
  for (const output of [a.output, b.output, control.output, resultA, resultB, changed]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'a.mjs': changedA });
  assert.equal(existsSync(sentinel), false);
});
