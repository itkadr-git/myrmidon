import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  return { stdout: result.stdout, payload };
}

test('fresh scanner reports reflect removal and restoration of a cyclic source', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'condensation-source-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(source); mkdirSync(cwd);
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const files = {
    'entry.mjs': `import './a.mjs';\nimport './c.mjs';\n${guard}// entry padding\n`,
    'a.mjs': `import './b.mjs';\n${guard}// a padding longer\n`,
    'b.mjs': `import './a.mjs';\n${guard}// b\n`,
    'c.mjs': `import './d.mjs';\n${guard}// c padding long enough\n`,
    'd.mjs': `import('./c.mjs');\n${guard}// d padding\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  const size = name => Buffer.byteLength(files[name]);
  assert.equal(new Set(Object.keys(files).map(size)).size, 5, 'source lengths must differ');
  const component = (...paths) => ({ id: paths[0], paths, bytes: paths.reduce((n, path) => n + size(path), 0) });
  const edge = (from, to) => ({ from, to });
  const expected = (missing, mode) => ({
    entry: 'entry.mjs',
    components: [
      missing ? component('a.mjs') : component('a.mjs', 'b.mjs'),
      ...(mode === 'all' ? [component('c.mjs', 'd.mjs')] : [component('c.mjs'), component('d.mjs')]),
      component('entry.mjs'),
    ],
    edges: [
      ...(mode === 'eager' ? [edge('c.mjs', 'd.mjs')] : []),
      edge('entry.mjs', 'a.mjs'), edge('entry.mjs', 'c.mjs'),
    ],
  });
  function unchanged(missing) {
    for (const [name, text] of Object.entries(files)) {
      if (missing && name === 'b.mjs') { assert.equal(existsSync(join(source, name)), false); continue; }
      assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false, 'source must not execute');
  }
  function scan(missing) {
    const result = run(scanner, [join(source, 'entry.mjs')], cwd);
    unchanged(missing);
    return result;
  }
  function check(report, missing) {
    for (const mode of ['eager', 'all']) {
      const result = run(consumer, [mode], cwd, report.stdout);
      assert.deepEqual(result.payload, expected(missing, mode), mode);
      unchanged(missing);
    }
  }
  const initial = scan(false);
  check(initial, false);
  unlinkSync(join(source, 'b.mjs'));
  const removed = scan(true);
  assert.equal(removed.payload.modules.some(m => m.path === 'b.mjs'), false);
  assert.deepEqual(removed.payload.unknown, [{ from: 'a.mjs', specifier: './b.mjs', kind: 'eager', to: null }]);
  assert.deepEqual(removed.payload.edges.filter(e => e.from === 'a.mjs'), removed.payload.unknown);
  // A stale report must not satisfy the removal expectation.
  assert.throws(() => assert.deepEqual(run(consumer, ['all'], cwd, initial.stdout).payload, expected(true, 'all')), assert.AssertionError);
  unchanged(true);
  check(removed, true);
  writeFileSync(join(source, 'b.mjs'), files['b.mjs']);
  const restored = scan(false);
  assert.deepEqual(restored.payload, initial.payload);
  check(restored, false);
});
