import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-dominators.mjs', import.meta.url));

test('scanner and dominators recover when a diamond dependency disappears and returns', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(scratch, 'dominator-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceDir = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(sourceDir); mkdirSync(cwd);
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\n${guard}`,
    'a.mjs': `import './leaf.mjs';\n${guard}// a long branch\n`,
    'b.mjs': `import './leaf.mjs';\n${guard}// b\n`,
    'leaf.mjs': `${guard}// leaf\n`,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(sourceDir, name), text);
  const lengths = Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, Buffer.byteLength(text)]));
  assert.equal(new Set(Object.values(lengths)).size, 4);
  const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
  function expectedReport(missing) {
    const names = missing ? ['a.mjs', 'entry.mjs', 'leaf.mjs'] : ['a.mjs', 'b.mjs', 'entry.mjs', 'leaf.mjs'];
    const modules = names.map(path => ({ path, bytes: lengths[path], eager: true }));
    const edges = [edge('a.mjs', './leaf.mjs', 'leaf.mjs'),
      ...(!missing ? [edge('b.mjs', './leaf.mjs', 'leaf.mjs')] : []),
      edge('entry.mjs', './a.mjs', 'a.mjs'), edge('entry.mjs', './b.mjs', missing ? null : 'b.mjs')];
    const total = names.reduce((sum, name) => sum + lengths[name], 0);
    return { entry: 'entry.mjs', modules, edges, unknown: missing ? [edge('entry.mjs', './b.mjs', null)] : [],
      counts: { modules: names.length, eagerModules: names.length, edges: edges.length },
      bytes: { total, eager: total }, heaviestEager: [...modules].sort((a, b) => b.bytes - a.bytes) };
  }
  function intact(missing = []) {
    for (const [name, text] of Object.entries(sources)) {
      if (missing.includes(name)) assert.equal(existsSync(join(sourceDir, name)), false, name);
      else assert.equal(readFileSync(join(sourceDir, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false);
  }
  function run(script, args, input, status = 0) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stderr, status ? 'Entry file not found\n' : '');
    return result.stdout;
  }
  const entry = join(sourceDir, 'entry.mjs');
  function scan(missing) {
    const stdout = run(scanner, [entry]);
    assert.deepEqual(JSON.parse(stdout), expectedReport(missing));
    intact(missing ? ['b.mjs'] : []);
    return stdout;
  }
  function consume(report, missing) {
    const stdout = run(consumer, ['-', 'leaf.mjs'], report);
    assert.deepEqual(JSON.parse(stdout), { entry: 'entry.mjs', target: 'leaf.mjs', dominators: missing
      ? ['a.mjs', 'entry.mjs', 'leaf.mjs'] : ['entry.mjs', 'leaf.mjs'] });
    intact(missing ? ['b.mjs'] : []);
  }
  const original = scan(false);
  consume(original, false);
  unlinkSync(join(sourceDir, 'b.mjs'));
  const removed = scan(true);
  assert.throws(() => consume(original, true), assert.AssertionError);
  consume(removed, true);
  writeFileSync(join(sourceDir, 'b.mjs'), sources['b.mjs']);
  const restored = scan(false);
  assert.equal(restored, original);
  consume(restored, false);
  unlinkSync(entry);
  assert.equal(run(scanner, [entry], undefined, 1), '');
  intact(['entry.mjs']);
});
