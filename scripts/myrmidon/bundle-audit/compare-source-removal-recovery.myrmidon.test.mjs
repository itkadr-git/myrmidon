import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const compare = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));

test('compares fresh reports after physical removal and restoration of a source dependency', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME, 'source-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = join(root, 'executed');
  const sources = {
    'entry.mjs': `import './bridge.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`,
    'bridge.mjs': "import './leaf.mjs';\nexport const bridge = 1;\n",
    'leaf.mjs': 'export const leaf = 2;\n',
  };
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(root, name), content);
  const run = (...args) => {
    const result = spawnSync(process.execPath, args, { cwd: '/', encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const mod = name => ({ path: name, bytes: Buffer.byteLength(sources[name]), eager: true });
  const [bridge, entry, leaf] = ['bridge.mjs', 'entry.mjs', 'leaf.mjs'].map(mod);
  const entryEdge = { from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: 'bridge.mjs' };
  const bridgeEdge = { from: 'bridge.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' };
  const missingEdge = { ...entryEdge, to: null };
  const total = bridge.bytes + entry.bytes + leaf.bytes;
  const baselineExpected = {
    entry: 'entry.mjs', modules: [bridge, entry, leaf], edges: [bridgeEdge, entryEdge], unknown: [],
    counts: { modules: 3, eagerModules: 3, edges: 2 }, bytes: { total, eager: total },
    heaviestEager: [bridge, entry, leaf].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)),
  };
  const removedExpected = {
    entry: 'entry.mjs', modules: [entry], edges: [missingEdge], unknown: [missingEdge],
    counts: { modules: 1, eagerModules: 1, edges: 1 }, bytes: { total: entry.bytes, eager: entry.bytes }, heaviestEager: [entry],
  };
  const checkSources = removed => {
    assert.equal(existsSync(sentinel), false);
    for (const [name, content] of Object.entries(sources)) {
      if (removed && name === 'bridge.mjs') assert.equal(existsSync(join(root, name)), false);
      else assert.equal(readFileSync(join(root, name), 'utf8'), content);
    }
  };
  const scan = (name, expected, removed = false) => {
    const output = run(scanner, join(root, 'entry.mjs'));
    assert.deepEqual(JSON.parse(output), expected);
    checkSources(removed);
    const path = join(root, `${name}.json`);
    writeFileSync(path, output);
    return path;
  };
  const baseline = scan('baseline', baselineExpected);
  unlinkSync(join(root, 'bridge.mjs'));
  const removed = scan('removed', removedExpected, true);
  writeFileSync(join(root, 'bridge.mjs'), sources['bridge.mjs']);
  const restored = scan('restored', baselineExpected);
  assert.deepEqual(JSON.parse(readFileSync(restored, 'utf8')), JSON.parse(readFileSync(baseline, 'utf8')));
  const lostBytes = bridge.bytes + leaf.bytes;
  const delta = sign => ({ modules: sign * 2, eagerModules: sign * 2, totalBytes: sign * lostBytes, eagerBytes: sign * lostBytes });
  const zero = { modules: 0, eagerModules: 0, totalBytes: 0, eagerBytes: 0 };
  const check = (before, after, expected) => {
    assert.deepEqual(JSON.parse(run(compare, before, after)), expected);
    checkSources(false);
  };
  check(baseline, removed, { entry: 'entry.mjs', delta: delta(-1), added: [], removed: [bridge, leaf], changed: [] });
  check(removed, restored, { entry: 'entry.mjs', delta: delta(1), added: [bridge, leaf], removed: [], changed: [] });
  check(baseline, restored, { entry: 'entry.mjs', delta: zero, added: [], removed: [], changed: [] });
});
