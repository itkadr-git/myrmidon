import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));

function run(script, args, cwd, input) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout);
  return result.stdout;
}

test('fresh scans track physical dependency removal and restoration', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'cut-removal-tests');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'cut-removal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  const cwd = join(dir, 'unrelated');
  mkdirSync(source); mkdirSync(cwd);
  const sentinel = join(dir, 'sentinel');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\n${guard}// entry padding\n`,
    'a.mjs': `import './shared.mjs';\n${guard}// a padding\n`,
    'b.mjs': `import './shared.mjs';\n${guard}`,
    'shared.mjs': `${guard}// shared padding to ensure distinct sizes\n`,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(source, name), text);
  assert.equal(new Set(Object.values(sources).map(text => Buffer.byteLength(text))).size, 4);
  const intact = missing => {
    for (const [name, text] of Object.entries(sources)) {
      if (name === missing) assert.equal(existsSync(join(source, name)), false);
      else assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false);
  };
  const bytes = paths => paths.reduce((n, name) => n + Buffer.byteLength(sources[name]), 0);
  const expected = (removed, lostPaths) => ({ entry: 'entry.mjs', removed, lostPaths, lostBytes: bytes(lostPaths) });
  const scan = missing => {
    const output = run(scanner, [join(source, 'entry.mjs')], cwd);
    const report = JSON.parse(output);
    intact(missing);
    return { output, report };
  };
  const check = (output, removed, lostPaths, missing) => {
    const result = JSON.parse(run(consumer, [removed], cwd, output));
    intact(missing);
    assert.deepEqual(result, expected(removed, lostPaths));
  };
  const full = ['a.mjs', 'b.mjs', 'entry.mjs', 'shared.mjs'];
  const reduced = ['a.mjs', 'entry.mjs', 'shared.mjs'];
  const initial = scan();
  check(initial.output, 'a.mjs', ['a.mjs']);
  check(initial.output, 'entry.mjs', full);

  unlinkSync(join(source, 'b.mjs'));
  const removed = scan('b.mjs');
  assert.deepEqual(removed.report.modules.map(module => module.path), reduced);
  assert.deepEqual(removed.report.unknown, [{ from: 'entry.mjs', specifier: './b.mjs', kind: 'eager', to: null }]);
  assert.deepEqual(removed.report.edges.filter(edge => edge.to === null), removed.report.unknown);
  check(removed.output, 'a.mjs', ['a.mjs', 'shared.mjs'], 'b.mjs');
  check(removed.output, 'entry.mjs', reduced, 'b.mjs');

  writeFileSync(join(source, 'b.mjs'), sources['b.mjs']);
  const restored = scan();
  assert.deepEqual(restored.report, initial.report);
  check(restored.output, 'a.mjs', ['a.mjs']);
  check(restored.output, 'entry.mjs', full);
});
