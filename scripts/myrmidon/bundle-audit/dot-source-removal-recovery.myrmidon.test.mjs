import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));

test('DOT follows physical source removal and byte-for-byte recovery', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dot-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'unrelated');
  // A separate existing directory ensures neither CLI relies on its working directory.
  mkdirSync(cwd);
  const sentinel = join(dir, 'executed');
  const sources = {
    'entry.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\nimport './bridge.mjs';\nimport('./lazy"file.mjs');\n`,
    'bridge.mjs': "import './leaf.mjs';\n",
    'leaf.mjs': 'export const leaf = 1;\n',
    'lazy"file.mjs': 'export default 2;\n',
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  const bytes = name => Buffer.byteLength(sources[name]);
  const entry = { path: 'entry.mjs', bytes: bytes('entry.mjs'), eager: true };
  const bridge = { path: 'bridge.mjs', bytes: bytes('bridge.mjs'), eager: true };
  const leaf = { path: 'leaf.mjs', bytes: bytes('leaf.mjs'), eager: true };
  const lazy = { path: 'lazy"file.mjs', bytes: bytes('lazy"file.mjs'), eager: false };
  const bridgeLeaf = { from: 'bridge.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' };
  const entryBridge = { from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: 'bridge.mjs' };
  const missingBridge = { ...entryBridge, to: null };
  const entryLazy = { from: 'entry.mjs', specifier: './lazy"file.mjs', kind: 'lazy', to: 'lazy"file.mjs' };
  const eagerBytes = entry.bytes + bridge.bytes + leaf.bytes;
  const baseline = {
    entry: 'entry.mjs', modules: [bridge, entry, lazy, leaf], edges: [bridgeLeaf, entryBridge, entryLazy], unknown: [],
    counts: { modules: 4, eagerModules: 3, edges: 3 }, bytes: { total: eagerBytes + lazy.bytes, eager: eagerBytes },
    heaviestEager: [entry, leaf, bridge],
  };
  const removed = {
    entry: 'entry.mjs', modules: [entry, lazy], edges: [missingBridge, entryLazy], unknown: [missingBridge],
    counts: { modules: 2, eagerModules: 1, edges: 2 }, bytes: { total: entry.bytes + lazy.bytes, eager: entry.bytes }, heaviestEager: [entry],
  };
  const initialDot = 'digraph imports {\n  n0 [label="bridge.mjs", style=solid];\n  n1 [label="entry.mjs", style=solid];\n  n2 [label="lazy\\"file.mjs", style=dashed];\n  n3 [label="leaf.mjs", style=solid];\n  n0 -> n3 [label="./leaf.mjs", style=solid];\n  n1 -> n0 [label="./bridge.mjs", style=solid];\n  n1 -> n2 [label="./lazy\\"file.mjs", style=dashed];\n  // unresolved: 0\n}\n';
  const removedDot = 'digraph imports {\n  n0 [label="entry.mjs", style=solid];\n  n1 [label="lazy\\"file.mjs", style=dashed];\n  n0 -> n1 [label="./lazy\\"file.mjs", style=dashed];\n  // unresolved: 1\n}\n';
  const check = result => {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  };
  const phase = (expected, dot, bridgePresent) => {
    const scan = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { cwd, encoding: 'utf8', timeout: 5000 });
    check(scan);
    assert.equal(scan.stdout, `${JSON.stringify(expected, null, 2)}\n`);
    const rendered = spawnSync(process.execPath, [consumer], { cwd, input: scan.stdout, encoding: 'utf8', timeout: 5000 });
    check(rendered);
    assert.equal(rendered.stdout, dot);
    assert.equal(existsSync(sentinel), false);
    for (const [name, source] of Object.entries(sources)) {
      if (name === 'bridge.mjs' && !bridgePresent) assert.equal(existsSync(join(dir, name)), false);
      else assert.equal(readFileSync(join(dir, name), 'utf8'), source);
    }
    return scan.stdout;
  };
  const first = phase(baseline, initialDot, true);
  unlinkSync(join(dir, 'bridge.mjs'));
  phase(removed, removedDot, false);
  writeFileSync(join(dir, 'bridge.mjs'), sources['bridge.mjs']);
  assert.equal(phase(baseline, initialDot, true), first);
});
