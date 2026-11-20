import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const limits = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));

test('fresh scanner reports drive limits after physical removal and recovery', t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME, 'limits-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const cwd = join(root, 'unrelated');
  mkdirSync(sourceDir);
  mkdirSync(cwd);
  const entry = join(sourceDir, 'entry.mjs');
  const bridge = join(sourceDir, 'bridge.mjs');
  const sentinel = join(root, 'executed');
  const entrySource = `import './bridge.mjs';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('source executed');\n`;
  const bridgeSource = 'export const bridge = 42;\n';
  writeFileSync(entry, entrySource);
  writeFileSync(bridge, bridgeSource);
  const entryBytes = Buffer.byteLength(entrySource);
  const bridgeBytes = Buffer.byteLength(bridgeSource);
  const maxBytes = entryBytes + bridgeBytes - 1;
  const entryModule = { path: 'entry.mjs', bytes: entryBytes, eager: true };
  const bridgeModule = { path: 'bridge.mjs', bytes: bridgeBytes, eager: true };
  const edge = to => ({ from: 'entry.mjs', specifier: './bridge.mjs', kind: 'eager', to });
  const expectedScan = present => ({
    entry: 'entry.mjs',
    modules: present ? [bridgeModule, entryModule] : [entryModule],
    edges: [edge(present ? 'bridge.mjs' : null)],
    unknown: present ? [] : [edge(null)],
    counts: { modules: present ? 2 : 1, eagerModules: present ? 2 : 1, edges: 1 },
    bytes: { total: entryBytes + (present ? bridgeBytes : 0), eager: entryBytes + (present ? bridgeBytes : 0) },
    heaviestEager: present ? [entryModule, bridgeModule] : [entryModule],
  });
  const invoke = (script, args, input) => spawnSync(process.execPath, [script, ...args], { cwd, input, encoding: 'utf8', timeout: 10000 });
  const checkProcess = (result, status) => {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, status);
    assert.equal(result.stderr, '');
  };
  const scan = present => {
    const result = invoke(scanner, [entry]);
    checkProcess(result, 0);
    assert.deepEqual(JSON.parse(result.stdout), expectedScan(present));
    return result.stdout;
  };
  const consume = (input, present) => {
    const result = invoke(limits, ['--max-eager-bytes', String(maxBytes), '--max-eager-modules', '2'], input);
    checkProcess(result, present ? 1 : 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: !present, eagerBytes: entryBytes + (present ? bridgeBytes : 0), eagerModules: present ? 2 : 1,
      maxEagerBytes: maxBytes, maxEagerModules: 2, violations: present ? ['eagerBytes'] : [],
    });
  };
  const checkSources = present => {
    assert.equal(existsSync(sentinel), false);
    assert.equal(readFileSync(entry, 'utf8'), entrySource);
    assert.equal(existsSync(bridge), present);
    if (present) assert.equal(readFileSync(bridge, 'utf8'), bridgeSource);
  };

  const baseline = scan(true);
  consume(baseline, true);
  checkSources(true);
  unlinkSync(bridge);
  const removed = scan(false);
  consume(removed, false);
  checkSources(false);
  writeFileSync(bridge, bridgeSource);
  const restored = scan(true);
  assert.deepEqual(JSON.parse(restored), JSON.parse(baseline));
  consume(restored, true);
  checkSources(true);
});
