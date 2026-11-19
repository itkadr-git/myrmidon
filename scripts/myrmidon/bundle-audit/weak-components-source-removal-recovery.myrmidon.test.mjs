import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-weak-components.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return result.stdout;
}

test('fresh scanner partitions follow source removal and exact restoration', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'weak-removal-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(source); mkdirSync(cwd);
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('executed');\n`;
  const files = {
    'entry.mjs': `import './bridge.mjs';\nimport('./lazy.mjs');\n${guard}// entry padding\n`,
    'bridge.mjs': `import './leaf.mjs';\n${guard}// bridge\n`,
    'leaf.mjs': `${guard}// leaf padding longer than bridge padding\n`,
    'lazy.mjs': `${guard}// lazy\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  const bytes = paths => paths.reduce((sum, name) => sum + Buffer.byteLength(files[name]), 0);
  const component = paths => ({ id: paths[0], paths, bytes: bytes(paths) });
  const expected = (removed, mode) => {
    const eager = removed ? ['entry.mjs'] : ['bridge.mjs', 'entry.mjs', 'leaf.mjs'];
    const paths = removed ? ['entry.mjs', 'lazy.mjs'] : ['bridge.mjs', 'entry.mjs', 'lazy.mjs', 'leaf.mjs'];
    return { entry: 'entry.mjs', components: mode === 'all' ? [component(paths)] : [component(eager), component(['lazy.mjs'])] };
  };
  const unchanged = removed => {
    for (const [name, text] of Object.entries(files)) {
      if (removed && name === 'bridge.mjs') { assert.equal(existsSync(join(source, name)), false); continue; }
      assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false);
  };
  const scan = removed => {
    const output = run(scanner, [join(source, 'entry.mjs')], cwd);
    const report = JSON.parse(output);
    unchanged(removed);
    return { output, report };
  };
  const check = (output, removed) => {
    for (const mode of ['eager', 'all']) {
      const actual = JSON.parse(run(consumer, [mode], cwd, output));
      unchanged(removed);
      assert.deepEqual(actual, expected(removed, mode), `${mode} ${removed ? 'removed' : 'present'}`);
    }
  };
  assert.equal(new Set(Object.values(files).map(text => Buffer.byteLength(text))).size, 4);
  const initial = scan(false);
  check(initial.output, false);
  unlinkSync(join(source, 'bridge.mjs'));
  const missing = scan(true);
  assert.deepEqual(missing.report.unknown, [{ from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: null }]);
  assert.deepEqual(missing.report.edges.find(edge => edge.specifier === './bridge.mjs'), missing.report.unknown[0]);
  assert.equal(missing.report.modules.some(module => ['bridge.mjs', 'leaf.mjs'].includes(module.path)), false);
  check(missing.output, true);
  writeFileSync(join(source, 'bridge.mjs'), files['bridge.mjs']);
  const restored = scan(false);
  assert.deepEqual(restored.report, initial.report);
  check(restored.output, false);
});
