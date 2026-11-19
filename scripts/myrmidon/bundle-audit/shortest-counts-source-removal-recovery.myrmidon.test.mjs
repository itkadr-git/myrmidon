import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));

test('fresh scanner reports reflect source removal and restoration in shortest counts', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'shortest-recovery');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'shortest-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(source); mkdirSync(cwd);
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const texts = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\nimport('./leaf.mjs');\n${guard}`,
    'a.mjs': `import './leaf.mjs';\n${guard}// a padding\n`,
    'b.mjs': `import './leaf.mjs';\n${guard}// b has longer padding than a\n`,
    'leaf.mjs': `${guard}// leaf\n`,
  };
  for (const [name, text] of Object.entries(texts)) writeFileSync(join(source, name), text);
  const lengths = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, Buffer.byteLength(text)]));
  assert.equal(new Set(Object.values(lengths)).size, 4, 'source byte lengths must not tie');
  const unchanged = removed => {
    for (const [name, text] of Object.entries(texts)) {
      if (name === removed) assert.equal(existsSync(join(source, name)), false);
      else assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false, 'source must not execute');
  };
  const run = (script, args, input, removed) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout);
    unchanged(removed);
    return { text: result.stdout, parsed };
  };
  const expected = removed => ({
    entry: 'entry.mjs',
    modules: [
      { path: 'a.mjs', depth: 1, shortestPaths: '1' },
      ...(!removed ? [{ path: 'b.mjs', depth: 1, shortestPaths: '1' }] : []),
      { path: 'entry.mjs', depth: 0, shortestPaths: '1' },
      { path: 'leaf.mjs', depth: 2, shortestPaths: removed ? '1' : '2' },
    ],
    unreachable: [],
  });
  const scan = removed => run(scanner, [join(source, 'entry.mjs')], undefined, removed);
  const consume = (report, removed) => run(consumer, [], report, removed).parsed;
  const initial = scan();
  assert.deepEqual(initial.parsed.modules, ['a.mjs', 'b.mjs', 'entry.mjs', 'leaf.mjs'].map(path => ({ path, bytes: lengths[path], eager: true })));
  assert.deepEqual(consume(initial.text), expected(false));

  unlinkSync(join(source, 'b.mjs'));
  const missing = scan('b.mjs');
  assert.deepEqual(missing.parsed.modules, ['a.mjs', 'entry.mjs', 'leaf.mjs'].map(path => ({ path, bytes: lengths[path], eager: true })));
  const missingEdge = { from: 'entry.mjs', specifier: './b.mjs', kind: 'eager', to: null };
  assert.deepEqual(missing.parsed.unknown, [missingEdge]);
  assert.deepEqual(missing.parsed.edges.filter(edge => edge.specifier === './b.mjs'), [missingEdge]);
  assert.deepEqual(consume(missing.text, 'b.mjs'), expected(true));

  // The stale report must not satisfy the model for the physically missing source.
  assert.throws(() => assert.deepEqual(consume(initial.text, 'b.mjs'), expected(true)), assert.AssertionError);

  writeFileSync(join(source, 'b.mjs'), texts['b.mjs']);
  const restored = scan();
  assert.deepEqual(restored.parsed, initial.parsed);
  assert.deepEqual(consume(restored.text), expected(false));
});
