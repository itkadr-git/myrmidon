import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));

test('fresh scans reflect physical dependency removal and recovery without executing source', t => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-recovery');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'unrelated');
  mkdirSync(cwd);
  const sentinel = join(dir, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './bridge.mjs';\nimport './leaf.mjs';\n${guard}`,
    'bridge.mjs': `import './leaf.mjs';\n${guard}`,
    'leaf.mjs': guard,
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, name), text);
  const bytes = name => Buffer.byteLength(sources[name]);
  const module = name => ({ path: name, bytes: bytes(name), eager: true });
  const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
  const bridgeEdge = edge('entry.mjs', './bridge.mjs', 'bridge.mjs');
  const leafEdge = edge('entry.mjs', './leaf.mjs', 'leaf.mjs');
  const report = removed => {
    const modules = (removed ? ['entry.mjs', 'leaf.mjs'] : ['bridge.mjs', 'entry.mjs', 'leaf.mjs']).map(module);
    const edges = removed ? [edge('entry.mjs', './bridge.mjs', null), leafEdge] : [edge('bridge.mjs', './leaf.mjs', 'leaf.mjs'), bridgeEdge, leafEdge];
    const total = modules.reduce((sum, item) => sum + item.bytes, 0);
    return { entry: 'entry.mjs', modules, edges, unknown: removed ? [edges[0]] : [], counts: { modules: modules.length, eagerModules: modules.length, edges: edges.length }, bytes: { total, eager: total }, heaviestEager: [...modules].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)) };
  };
  const expected = { entry: 'entry.mjs', selected: { from: 'entry.mjs', specifier: './bridge.mjs', to: 'bridge.mjs' }, before: { modules: 3, bytes: bytes('entry.mjs') + bytes('bridge.mjs') + bytes('leaf.mjs') }, after: { modules: 2, bytes: bytes('entry.mjs') + bytes('leaf.mjs') }, removedPaths: ['bridge.mjs'], savedBytes: bytes('bridge.mjs') };
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  const verifyProcess = (result, status, stdout, stderr) => {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, status);
    assert.equal(result.stderr, stderr);
    assert.equal(result.stdout, stdout);
  };
  const scan = removed => {
    const result = run(scanner, [join(dir, 'entry.mjs')]);
    verifyProcess(result, 0, JSON.stringify(report(removed), null, 2) + '\n', '');
    return result.stdout;
  };
  const consume = (text, removed) => {
    const path = join(dir, 'report.json');
    writeFileSync(path, text);
    const result = run(consumer, [path, 'entry.mjs', './bridge.mjs']);
    verifyProcess(result, removed ? 1 : 0, removed ? '' : JSON.stringify(expected) + '\n', removed ? 'error: selection\n' : '');
    assert.equal(readFileSync(path, 'utf8'), text);
  };
  const intact = removed => {
    assert.equal(existsSync(sentinel), false);
    for (const [name, text] of Object.entries(sources)) {
      if (removed && name === 'bridge.mjs') { assert.equal(existsSync(join(dir, name)), false); continue; }
      assert.equal(readFileSync(join(dir, name), 'utf8'), text);
    }
  };

  const baseline = scan(false);
  consume(baseline, false);
  intact(false);
  unlinkSync(join(dir, 'bridge.mjs'));
  const missing = scan(true);
  consume(missing, true);
  intact(true);
  writeFileSync(join(dir, 'bridge.mjs'), sources['bridge.mjs']);
  const restored = scan(false);
  assert.equal(restored, baseline);
  consume(restored, false);
  intact(false);
});
