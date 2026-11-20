import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));

test('sinks follow physical source removal and restoration', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME, 'sinks-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = join(root, 'executed');
  const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const sources = {
    'entry.mjs': `import './bridge.mjs';\n${guard}`,
    'bridge.mjs': `import './leaf.mjs';\n${guard}`,
    'leaf.mjs': guard,
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(root, name), source);
  const bytes = name => Buffer.byteLength(sources[name]);
  const entryModule = { path: 'entry.mjs', bytes: bytes('entry.mjs'), eager: true };
  const bridgeModule = { path: 'bridge.mjs', bytes: bytes('bridge.mjs'), eager: true };
  const leafModule = { path: 'leaf.mjs', bytes: bytes('leaf.mjs'), eager: true };
  const entryEdge = { from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: 'bridge.mjs' };
  const bridgeEdge = { from: 'bridge.mjs', specifier: './leaf.mjs', kind: 'eager', to: 'leaf.mjs' };
  const unknownEdge = { from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to: null };
  const total = bytes('entry.mjs') + bytes('bridge.mjs') + bytes('leaf.mjs');
  const expectedBaseline = {
    entry: 'entry.mjs', modules: [bridgeModule, entryModule, leafModule],
    edges: [bridgeEdge, entryEdge], unknown: [],
    counts: { modules: 3, eagerModules: 3, edges: 2 },
    bytes: { total, eager: total }, heaviestEager: [entryModule, bridgeModule, leafModule],
  };
  const expectedRemoved = {
    entry: 'entry.mjs', modules: [entryModule], edges: [unknownEdge], unknown: [unknownEdge],
    counts: { modules: 1, eagerModules: 1, edges: 1 },
    bytes: { total: bytes('entry.mjs'), eager: bytes('entry.mjs') }, heaviestEager: [entryModule],
  };
  const run = (cli, args, input) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: process.env.HOME, encoding: 'utf8', input });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const scan = () => run(scanner, [join(root, 'entry.mjs')]);
  const checkConsumer = (input, name) => {
    const expected = { entry: 'entry.mjs', sinks: [{ path: name, bytes: bytes(name) }], sinkBytes: bytes(name) };
    assert.equal(run(consumer, [], input), JSON.stringify(expected) + '\n');
  };
  const unchanged = names => {
    assert.equal(existsSync(sentinel), false);
    for (const name of names) assert.equal(readFileSync(join(root, name), 'utf8'), sources[name]);
  };

  const baseline = scan();
  assert.deepEqual(JSON.parse(baseline), expectedBaseline);
  checkConsumer(baseline, 'leaf.mjs');
  unchanged(Object.keys(sources));

  unlinkSync(join(root, 'bridge.mjs'));
  const removed = scan();
  assert.deepEqual(JSON.parse(removed), expectedRemoved);
  checkConsumer(removed, 'entry.mjs');
  unchanged(['entry.mjs', 'leaf.mjs']);
  assert.equal(existsSync(join(root, 'bridge.mjs')), false);

  writeFileSync(join(root, 'bridge.mjs'), sources['bridge.mjs']);
  const restored = scan();
  assert.deepEqual(JSON.parse(restored), expectedBaseline);
  assert.deepEqual(JSON.parse(restored), JSON.parse(baseline));
  checkConsumer(restored, 'leaf.mjs');
  unchanged(Object.keys(sources));
});
