import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));

test('layers track source deletion and recovery in a diamond', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'layers-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), cwd = join(dir, 'unrelated'), sentinel = join(dir, 'sentinel');
  mkdirSync(source); mkdirSync(cwd);
  const sources = {
    'entry.mjs': `import './a.mjs';\nimport './b.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('executed');\n`,
    'a.mjs': "import './leaf.mjs';\n// a\n",
    'b.mjs': "import './leaf.mjs';\n// longer b\n",
    'leaf.mjs': 'export const leaf = 1;\n',
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(source, name), text);
  const size = name => Buffer.byteLength(sources[name]);
  assert.equal(new Set(Object.keys(sources).map(size)).size, 4);
  const expected = (middle, leaf) => ({ entry: 'entry.mjs', layers: [
    { depth: 0, paths: ['entry.mjs'], bytes: size('entry.mjs') },
    { depth: 1, paths: middle, bytes: middle.reduce((sum, name) => sum + size(name), 0) },
    ...(leaf ? [{ depth: 2, paths: ['leaf.mjs'], bytes: size('leaf.mjs') }] : []),
  ], unreachable: [] });
  const intact = expected(['a.mjs', 'b.mjs'], true);
  const checkFiles = missing => {
    for (const [name, text] of Object.entries(sources)) {
      if (name === missing) assert.equal(existsSync(join(source, name)), false, name);
      else assert.equal(readFileSync(join(source, name), 'utf8'), text, name);
    }
    assert.equal(existsSync(sentinel), false, 'source must not execute');
  };
  const run = (script, args, input, missing) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    checkFiles(missing);
    return result.stdout;
  };
  const scan = missing => run(scanner, [join(source, 'entry.mjs')], undefined, missing);
  const layers = (report, missing) => JSON.parse(run(consumer, [], report, missing));
  const initial = scan();
  assert.deepEqual(layers(initial), intact);
  for (const [removed, expectedLayers, unknown] of [
    ['b.mjs', expected(['a.mjs'], true), [{ from: 'entry.mjs', specifier: './b.mjs', kind: 'eager', to: null }]],
    ['leaf.mjs', expected(['a.mjs', 'b.mjs'], false), [
      { from: 'a.mjs', specifier: './leaf.mjs', kind: 'eager', to: null },
      { from: 'b.mjs', specifier: './leaf.mjs', kind: 'eager', to: null },
    ]],
  ]) {
    unlinkSync(join(source, removed));
    const fresh = scan(removed), report = JSON.parse(fresh);
    assert.equal(report.modules.some(mod => mod.path === removed), false);
    assert.deepEqual(report.unknown, unknown);
    assert.deepEqual(report.edges.filter(edge => edge.to === null), unknown);
    assert.throws(() => assert.deepEqual(layers(initial, removed), expectedLayers), assert.AssertionError, 'stale report must fail');
    assert.deepEqual(layers(fresh, removed), expectedLayers);
    writeFileSync(join(source, removed), sources[removed]);
    const restored = scan();
    assert.deepEqual(JSON.parse(restored), JSON.parse(initial));
    assert.deepEqual(layers(restored), intact);
  }
});
