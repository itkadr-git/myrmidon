import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const consumer = process.env.MYRMIDON_LIMITS_TRANSITION_TEST_CLI || fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));

function run(cli, args, input, status) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

test('limits follow a static to dynamic to static edge transition without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'limits-transition-'));
  try {
    const sentinel = join(dir, 'executed');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const staticEntry = "import './bridge.mjs';\n" + trap;
    const dynamicEntry = "import('./bridge.mjs');\n" + trap;
    const bridge = "import './leaf.mjs';\n" + trap;
    const leaf = trap;
    const entryPath = join(dir, 'entry.mjs');
    writeFileSync(join(dir, 'bridge.mjs'), bridge);
    writeFileSync(join(dir, 'leaf.mjs'), leaf);
    writeFileSync(entryPath, staticEntry);
    const bytes = name => readFileSync(join(dir, name)).length;
    const maxBytes = Math.max(Buffer.byteLength(staticEntry), Buffer.byteLength(dynamicEntry)) + bytes('bridge.mjs') + bytes('leaf.mjs');

    const phase = (source, eagerModules, maxEagerBytes, maxEagerModules, violations) => {
      writeFileSync(entryPath, source);
      const eagerBytes = bytes('entry.mjs') + (eagerModules === 3 ? bytes('bridge.mjs') + bytes('leaf.mjs') : 0);
      const scan = run(scanner, [entryPath], undefined, 0);
      assert.deepEqual(scan.json.counts, { modules: 3, eagerModules, edges: 2 });
      assert.deepEqual(scan.json.bytes, { total: bytes('entry.mjs') + bytes('bridge.mjs') + bytes('leaf.mjs'), eager: eagerBytes });
      assert.deepEqual(scan.json.modules, [
        { path: 'bridge.mjs', bytes: bytes('bridge.mjs'), eager: eagerModules === 3 },
        { path: 'entry.mjs', bytes: bytes('entry.mjs'), eager: true },
        { path: 'leaf.mjs', bytes: bytes('leaf.mjs'), eager: eagerModules === 3 },
      ]);
      const result = run(consumer, ['--max-eager-bytes', String(maxEagerBytes), '--max-eager-modules', String(maxEagerModules)], scan.raw, violations.length ? 1 : 0);
      assert.deepEqual(result.json, { ok: violations.length === 0, eagerBytes, eagerModules, maxEagerBytes, maxEagerModules, violations });
      assert.equal(existsSync(sentinel), false);
      assert.equal(readFileSync(entryPath, 'utf8'), source);
      assert.equal(readFileSync(join(dir, 'bridge.mjs'), 'utf8'), bridge);
      assert.equal(readFileSync(join(dir, 'leaf.mjs'), 'utf8'), leaf);
    };
    phase(staticEntry, 3, maxBytes, 1, ['eagerModules']);
    phase(dynamicEntry, 1, maxBytes, 1, []);
    phase(staticEntry, 3, maxBytes, 1, ['eagerModules']);
    phase(staticEntry, 3, bytes('entry.mjs') + bytes('bridge.mjs') + bytes('leaf.mjs') - 1, 3, ['eagerBytes']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
