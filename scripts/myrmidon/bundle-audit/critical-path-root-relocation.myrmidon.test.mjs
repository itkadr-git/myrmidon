import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const consumer = join(dir, 'import-report-critical-path.mjs');

test('critical path is invariant under source root relocation and tracks a changed branch', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'critical-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  const sources = {
    'entry.mjs': "import './short.mjs';\nimport './long.mjs';\nimport('./lazy.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'short.mjs': "import './tail.mjs';\n// short\n",
    'long.mjs': "import './tail.mjs';\n// \u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\n",
    'tail.mjs': 'export const tail = true;\n',
    'lazy.mjs': `export const lazy = '${'x'.repeat(2048)}';\n`,
  };
  mkdirSync(first, { recursive: true });
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(first, name), text);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  const bytes = (...names) => names.reduce((sum, name) => sum + Buffer.byteLength(sources[name]), 0);
  assert.ok(Buffer.byteLength(sources['long.mjs']) > Buffer.byteLength(sources['short.mjs']));
  const expected = JSON.stringify({ entry: 'entry.mjs', paths: ['entry.mjs', 'long.mjs', 'tail.mjs'], bytes: bytes('entry.mjs', 'long.mjs', 'tail.mjs') }) + '\n';

  function run(script, args, input) {
    const result = spawnSync(process.execPath, [script, ...args], {
      input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TMPDIR: temp, RELOCATION_SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(JSON.parse(result.stdout), null, script === scanner ? 2 : undefined) + '\n');
    return result.stdout;
  }
  function scan(root, name) {
    const output = run(scanner, [join(root, 'entry.mjs')]);
    const path = join(temp, name);
    writeFileSync(path, output);
    return { path, output };
  }
  function analyze(report) {
    const output = run(consumer, [], readFileSync(report.path, 'utf8'));
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  const a = scan(first, 'first.json');
  const b = scan(second, 'second.json');
  assert.equal(a.output, b.output);
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

  const addition = `// ${'control'.repeat(20)}\n`;
  const changedShort = sources['short.mjs'] + addition;
  writeFileSync(join(second, 'short.mjs'), changedShort);
  const control = scan(second, 'control.json');
  const changed = analyze(control);
  const expectedControl = JSON.stringify({ entry: 'entry.mjs', paths: ['entry.mjs', 'short.mjs', 'tail.mjs'], bytes: bytes('entry.mjs', 'short.mjs', 'tail.mjs') + Buffer.byteLength(addition) }) + '\n';
  assert.equal(changed, expectedControl);
  for (const output of [control.output, changed]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  assert.equal(analyze(a), expected);
  assert.equal(analyze(b), expected);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'short.mjs': changedShort });
  assert.equal(existsSync(sentinel), false);
});
