import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const dot = join(dir, 'import-report-dot.mjs');

const expected = 'digraph imports {\n  n0 [label="entry.mjs", style=solid];\n  n1 [label="lazy.mjs", style=dashed];\n  n2 [label="left\\"side.mjs", style=solid];\n  n3 [label="right.mjs", style=solid];\n  n4 [label="shared.mjs", style=solid];\n  n0 -> n1 [label="./lazy.mjs", style=dashed];\n  n0 -> n2 [label="./left\\"side.mjs", style=solid];\n  n0 -> n3 [label="./right.mjs", style=solid];\n  n2 -> n4 [label="./shared.mjs", style=solid];\n  n3 -> n4 [label="./shared.mjs", style=solid];\n  // unresolved: 1\n}\n';
const expectedControl = 'digraph imports {\n  n0 [label="entry.mjs", style=solid];\n  n1 [label="lazy.mjs", style=solid];\n  n2 [label="left\\"side.mjs", style=solid];\n  n3 [label="right.mjs", style=solid];\n  n4 [label="shared.mjs", style=solid];\n  n0 -> n1 [label="./lazy.mjs", style=solid];\n  n0 -> n2 [label="./left\\"side.mjs", style=solid];\n  n0 -> n3 [label="./right.mjs", style=solid];\n  n2 -> n4 [label="./shared.mjs", style=solid];\n  n3 -> n4 [label="./shared.mjs", style=solid];\n  // unresolved: 1\n}\n';

test('DOT is identical across relocated source roots and reflects a lazy-to-eager control', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const temp = mkdtempSync(join(scratch, 'dot-relocation-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const first = join(temp, 'first');
  const second = join(temp, 'deeper path', '\u6e90 tree', 'second');
  const sentinel = join(temp, 'executed');
  mkdirSync(first, { recursive: true });
  const sources = {
    'entry.mjs': "import './left\"side.mjs';\nimport './right.mjs';\nimport('./lazy.mjs');\nimport 'missing-package';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.RELOCATION_SENTINEL, 'executed');\n",
    'left"side.mjs': "import './shared.mjs';\n",
    'right.mjs': "import './shared.mjs';\n",
    'shared.mjs': 'export const shared = true;\n',
    'lazy.mjs': 'export const lazy = true;\n',
  };
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(first, name), content);
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
    return result.stdout;
  }
  function scan(root, name) {
    const output = run(scanner, [join(root, 'entry.mjs')]);
    assert.equal(output, JSON.stringify(JSON.parse(output), null, 2) + '\n');
    const path = join(temp, name);
    writeFileSync(path, output);
    return { path, output };
  }
  function analyze(report) {
    const input = readFileSync(report.path, 'utf8');
    assert.equal(input, report.output);
    const output = run(dot, [], input);
    assert.equal(readFileSync(report.path, 'utf8'), report.output);
    return output;
  }
  function noRoots(outputs) {
    for (const output of outputs) {
      assert.ok(!output.includes(first));
      assert.ok(!output.includes(second));
    }
  }
  const a = scan(first, 'first-report.json');
  const b = scan(second, 'second-report.json');
  assert.equal(a.output, b.output);
  const resultA = analyze(a);
  const resultB = analyze(b);
  assert.equal(resultA, expected);
  assert.equal(resultB, expected);
  assert.equal(resultA, resultB);
  noRoots([a.output, b.output, resultA, resultB]);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  assert.equal(existsSync(sentinel), false);

  const changedEntry = sources['entry.mjs'].replace("import('./lazy.mjs');", "import './lazy.mjs';");
  writeFileSync(join(second, 'entry.mjs'), changedEntry);
  const control = scan(second, 'control-report.json');
  const changed = analyze(control);
  assert.equal(changed, expectedControl);
  assert.ok(!changed.includes('n1 [label="lazy.mjs", style=dashed]'));
  assert.ok(!changed.includes('n0 -> n1 [label="./lazy.mjs", style=dashed]'));
  noRoots([control.output, changed]);
  assert.equal(analyze(a), expected);
  assert.equal(readFileSync(b.path, 'utf8'), b.output);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'entry.mjs': changedEntry });
  assert.equal(existsSync(sentinel), false);
});
