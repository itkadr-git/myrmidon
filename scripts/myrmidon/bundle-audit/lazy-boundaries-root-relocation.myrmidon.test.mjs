import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const boundaries = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));

test('lazy frontier survives relocation and reflects a changed target', t => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-relocation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const first = join(scratch, 'first');
  const second = join(scratch, 'nested', 'tree space \u00e9');
  const sentinel = join(scratch, 'executed');
  const sources = {
    'entry.mjs': `import { writeFileSync } from 'node:fs';\nimport './eager.mjs';\nimport('./eager.mjs');\nimport('./lazy.mjs');\nwriteFileSync(process.env.SENTINEL, 'executed');\n`,
    'eager.mjs': 'export default 1;\n',
    'lazy.mjs': 'export default 2;\n',
  };
  mkdirSync(first, { recursive: true });
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(first, name), content);
  mkdirSync(join(scratch, 'nested'), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);

  function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: scratch, SENTINEL: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    return result.stdout;
  }
  function report(root, filename) {
    const scan = run(scanner, [join(root, 'entry.mjs')]);
    writeFileSync(filename, scan);
    const output = run(boundaries, [filename]);
    assert.equal(readFileSync(filename, 'utf8'), scan);
    return output;
  }
  const expected = { entry: 'entry.mjs', boundaries: [{ from: 'entry.mjs', specifier: './lazy.mjs', to: 'lazy.mjs', bytes: 18 }] };
  const report1 = join(scratch, 'first.json');
  const report2 = join(scratch, 'second.json');
  const out1 = report(first, report1);
  const out2 = report(second, report2);
  assert.equal(out1, `${JSON.stringify(expected)}\n`);
  assert.equal(out2, out1);
  for (const output of [out1, out2, readFileSync(report1, 'utf8'), readFileSync(report2, 'utf8')]) {
    assert.ok(!output.includes(first));
    assert.ok(!output.includes(second));
  }
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  const originalReport1 = readFileSync(report1, 'utf8');
  const originalReport2 = readFileSync(report2, 'utf8');
  writeFileSync(join(second, 'lazy.mjs'), 'export default 20;\n');
  const changed = report(second, join(scratch, 'changed.json'));
  const expectedChanged = { entry: 'entry.mjs', boundaries: [{ from: 'entry.mjs', specifier: './lazy.mjs', to: 'lazy.mjs', bytes: 19 }] };
  assert.equal(changed, `${JSON.stringify(expectedChanged)}\n`);
  assert.equal(report(first, join(scratch, 'first-again.json')), out1);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'lazy.mjs': 'export default 20;\n' });
  assert.equal(readFileSync(report1, 'utf8'), originalReport1);
  assert.equal(readFileSync(report2, 'utf8'), originalReport2);
  assert.equal(existsSync(sentinel), false);
});
