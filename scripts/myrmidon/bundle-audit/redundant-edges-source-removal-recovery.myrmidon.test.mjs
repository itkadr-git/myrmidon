import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));

test('fresh scanner graph tracks physical removal and recovery of an alternative path', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.env.HOME;
  assert.ok(scratch);
  const dir = mkdtempSync(join(scratch, 'redundant-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './bridge.mjs';\nimport './leaf.mjs';\n${guard}`,
    'bridge.mjs': `import './leaf.mjs';\n${guard}`,
    'leaf.mjs': guard,
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  const moduleFor = name => ({ path: name, bytes: Buffer.byteLength(sources[name]), eager: true });
  const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
  const bridgeLeaf = edge('bridge.mjs', './leaf.mjs', 'leaf.mjs');
  const entryBridge = edge('entry.mjs', './bridge.mjs', 'bridge.mjs');
  const missingBridge = edge('entry.mjs', './bridge.mjs', null);
  const entryLeaf = edge('entry.mjs', './leaf.mjs', 'leaf.mjs');
  function expectedScan(removed) {
    const modules = (removed ? ['entry.mjs', 'leaf.mjs'] : ['bridge.mjs', 'entry.mjs', 'leaf.mjs']).map(moduleFor);
    const edges = removed ? [missingBridge, entryLeaf] : [bridgeLeaf, entryBridge, entryLeaf];
    const total = modules.reduce((sum, mod) => sum + mod.bytes, 0);
    return { entry: 'entry.mjs', modules, edges, unknown: removed ? [missingBridge] : [],
      counts: { modules: modules.length, eagerModules: modules.length, edges: edges.length },
      bytes: { total, eager: total },
      heaviestEager: [...modules].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
  }
  const redundant = [{ from: 'entry.mjs', specifier: './leaf.mjs', to: 'leaf.mjs', alternativePath: ['entry.mjs', 'bridge.mjs', 'leaf.mjs'] }];
  function invoke(cli, args, input) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  }
  function phase(removed) {
    const stdout = invoke(scanner, [join(dir, 'entry.mjs')]);
    assert.deepEqual(JSON.parse(stdout), expectedScan(removed));
    const output = invoke(consumer, [], stdout);
    assert.deepEqual(JSON.parse(output), { entry: 'entry.mjs', redundant: removed ? [] : redundant });
    assert.equal(existsSync(sentinel), false);
    for (const [name, source] of Object.entries(sources)) {
      if (removed && name === 'bridge.mjs') assert.equal(existsSync(join(dir, name)), false);
      else assert.equal(readFileSync(join(dir, name), 'utf8'), source);
    }
    return stdout;
  }
  const baseline = phase(false);
  unlinkSync(join(dir, 'bridge.mjs'));
  const removed = phase(true);
  assert.throws(() => assert.deepEqual(JSON.parse(invoke(consumer, [], baseline)), { entry: 'entry.mjs', redundant: [] }));
  writeFileSync(join(dir, 'bridge.mjs'), sources['bridge.mjs']);
  assert.deepEqual(JSON.parse(phase(false)), JSON.parse(baseline));
  assert.deepEqual(JSON.parse(removed), expectedScan(true));
});
