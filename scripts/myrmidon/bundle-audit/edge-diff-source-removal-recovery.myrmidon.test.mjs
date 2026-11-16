import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

test('diffs fresh scanner reports across physical source removal and recovery', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-removal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'unrelated'); mkdirSync(cwd);
  const sentinel = join(dir, 'executed');
  const sources = {
    'entry.mjs': `import './bridge.mjs';\nimport('./lazy.mjs');\nimport 'external-package';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow Error('source executed');\n`,
    'bridge.mjs': "import './leaf.mjs';\nimport 'bridge-external';\n",
    'leaf.mjs': 'export const leaf = 1;\n',
    'lazy.mjs': 'export const lazy = 1;\n',
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  const entryBridge = edge('entry.mjs', './bridge.mjs', 'eager', 'bridge.mjs');
  const missingBridge = edge('entry.mjs', './bridge.mjs', 'eager', null);
  const bridgeLeaf = edge('bridge.mjs', './leaf.mjs', 'eager', 'leaf.mjs');
  const bridgeExternal = edge('bridge.mjs', 'bridge-external', 'eager', null);
  const entryLazy = edge('entry.mjs', './lazy.mjs', 'lazy', 'lazy.mjs');
  const entryExternal = edge('entry.mjs', 'external-package', 'eager', null);
  const module = (name, eager) => ({ path: name, bytes: Buffer.byteLength(sources[name]), eager });
  const baselineModules = [module('bridge.mjs', true), module('entry.mjs', true), module('lazy.mjs', false), module('leaf.mjs', true)];
  const removedModules = [module('entry.mjs', true), module('lazy.mjs', false)];
  function expectedReport(removed) {
    const modules = removed ? removedModules : baselineModules;
    const eager = modules.filter(m => m.eager);
    return {
      entry: 'entry.mjs', modules,
      edges: removed ? [missingBridge, entryLazy, entryExternal] : [bridgeLeaf, bridgeExternal, entryBridge, entryLazy, entryExternal],
      unknown: removed ? [missingBridge, entryExternal] : [bridgeExternal, entryExternal],
      counts: { modules: modules.length, eagerModules: eager.length, edges: removed ? 3 : 5 },
      bytes: { total: modules.reduce((sum, m) => sum + m.bytes, 0), eager: eager.reduce((sum, m) => sum + m.bytes, 0) },
      heaviestEager: [...eager].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)),
    };
  }
  function run(script, ...args) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return result.stdout;
  }
  function unchanged(removed) {
    assert.equal(existsSync(sentinel), false);
    for (const [name, source] of Object.entries(sources)) {
      if (removed && name === 'bridge.mjs') { assert.equal(existsSync(join(dir, name)), false); continue; }
      assert.equal(readFileSync(join(dir, name), 'utf8'), source);
    }
  }
  function scan(name, removed) {
    const output = run(scanner, join(dir, 'entry.mjs'));
    assert.equal(output, `${JSON.stringify(expectedReport(removed), null, 2)}\n`);
    const path = join(dir, `${name}.json`); writeFileSync(path, output);
    unchanged(removed);
    return { path, output };
  }
  function diff(base, current, added, removed, missing) {
    const output = run(consumer, base.path, current.path);
    assert.equal(output, `${JSON.stringify({ entry: 'entry.mjs', added, removed }, null, 2)}\n`);
    assert.equal(readFileSync(base.path, 'utf8'), base.output);
    assert.equal(readFileSync(current.path, 'utf8'), current.output);
    unchanged(missing);
  }
  const baseline = scan('baseline', false);
  unlinkSync(join(dir, 'bridge.mjs'));
  const removed = scan('removed', true);
  diff(baseline, removed, [missingBridge], [bridgeLeaf, bridgeExternal, entryBridge], true);
  writeFileSync(join(dir, 'bridge.mjs'), sources['bridge.mjs']);
  const restored = scan('restored', false);
  assert.equal(restored.output, baseline.output);
  diff(removed, restored, [bridgeLeaf, bridgeExternal, entryBridge], [missingBridge], false);
  diff(baseline, restored, [], [], false);
});
