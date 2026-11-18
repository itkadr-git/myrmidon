import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_EDGE_TRANSITION_TEST_CONSUMER || fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

test('fresh scans track static and dynamic edge transitions without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'sinks-transition-'));
  try {
    const sentinel = join(dir, 'executed');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const bridge = "import './leaf.mjs';\n" + trap;
    const leaf = trap;
    const entry = (dynamic, alternate = false) => `${dynamic ? "import('./bridge.mjs');" : "import './bridge.mjs';"}\n${alternate ? "import './leaf.mjs';\n" : ''}${trap}`;
    writeFileSync(join(dir, 'bridge.mjs'), bridge);
    writeFileSync(join(dir, 'leaf.mjs'), leaf);
    const check = (source, flags, sink) => {
      writeFileSync(join(dir, 'entry.mjs'), source);
      const scanned = run(scanner, [join(dir, 'entry.mjs')]);
      assert.equal(existsSync(sentinel), false, 'scanner executed a fixture');
      const consumed = run(consumer, [], scanned.raw);
      assert.equal(existsSync(sentinel), false, 'consumer executed a fixture');
      assert.deepEqual(scanned.json.modules.map(({ path, eager }) => ({ path, eager })), flags);
      const bytes = Buffer.byteLength(sink === 'entry.mjs' ? source : leaf);
      assert.deepEqual(consumed.json, { entry: 'entry.mjs', sinks: [{ path: sink, bytes }], sinkBytes: bytes });
      assert.equal(readFileSync(join(dir, 'bridge.mjs'), 'utf8'), bridge);
      assert.equal(readFileSync(join(dir, 'leaf.mjs'), 'utf8'), leaf);
      assert.equal(readFileSync(join(dir, 'entry.mjs'), 'utf8'), source);
      return consumed.json;
    };
    const allEager = [
      { path: 'bridge.mjs', eager: true }, { path: 'entry.mjs', eager: true }, { path: 'leaf.mjs', eager: true },
    ];
    const lazyBridge = [
      { path: 'bridge.mjs', eager: false }, { path: 'entry.mjs', eager: true }, { path: 'leaf.mjs', eager: false },
    ];
    const alternate = [
      { path: 'bridge.mjs', eager: false }, { path: 'entry.mjs', eager: true }, { path: 'leaf.mjs', eager: true },
    ];
    const first = check(entry(false), allEager, 'leaf.mjs');
    check(entry(true), lazyBridge, 'entry.mjs');
    assert.deepEqual(check(entry(false), allEager, 'leaf.mjs'), first);
    check(entry(true, true), alternate, 'leaf.mjs');
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
