import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-critical-path.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('critical path follows physical source removal and recovery', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'critical-source-tests');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'critical-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceDir = join(dir, 'source'), cwd = join(dir, 'unrelated');
  mkdirSync(sourceDir); mkdirSync(cwd);
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\n${guard}`,
    'a.mjs': `import './leaf.mjs';\n${guard}// a\n`,
    'b.mjs': `import './leaf.mjs';\n${guard}// ${'heavy '.repeat(50)}\n`,
    'leaf.mjs': `${guard}// \u00e9\n`,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(sourceDir, name), text);
  const size = name => Buffer.byteLength(sources[name], 'utf8');
  assert.ok(size('b.mjs') > size('a.mjs'));
  const expected = branch => ({ entry: 'entry.mjs', paths: ['entry.mjs', branch, 'leaf.mjs'], bytes: size('entry.mjs') + size(branch) + size('leaf.mjs') });
  const unchanged = missing => {
    for (const [name, text] of Object.entries(sources)) {
      if (name === missing) assert.equal(existsSync(join(sourceDir, name)), false);
      else assert.equal(readFileSync(join(sourceDir, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false, 'source must not execute');
  };
  const scan = missing => {
    const stdout = run(scanner, [join(sourceDir, 'entry.mjs')], cwd);
    unchanged(missing);
    return { stdout, report: JSON.parse(stdout) };
  };
  const consume = (stdout, missing) => {
    const result = JSON.parse(run(consumer, [], cwd, stdout));
    unchanged(missing);
    return result;
  };

  const initial = scan();
  assert.deepEqual(consume(initial.stdout), expected('b.mjs'));
  unlinkSync(join(sourceDir, 'b.mjs'));
  const removed = scan('b.mjs');
  const missingEdge = { from: 'entry.mjs', specifier: './b.mjs', kind: 'eager', to: null };
  assert.deepEqual(removed.report.unknown, [missingEdge]);
  assert.deepEqual(removed.report.edges.filter(edge => edge.from === 'entry.mjs' && edge.specifier === './b.mjs'), [missingEdge]);
  assert.deepEqual(removed.report.modules.map(mod => mod.path), ['a.mjs', 'entry.mjs', 'leaf.mjs']);
  assert.throws(() => assert.deepEqual(consume(initial.stdout, 'b.mjs'), expected('a.mjs')), assert.AssertionError);
  assert.deepEqual(consume(removed.stdout, 'b.mjs'), expected('a.mjs'));
  writeFileSync(join(sourceDir, 'b.mjs'), sources['b.mjs']);
  const restored = scan();
  assert.deepEqual(restored.report, initial.report);
  assert.deepEqual(consume(restored.stdout), expected('b.mjs'));
});
