import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const report = { modules: [{ path: 'a', bytes: 5, eager: true }, { path: 'b', bytes: 7, eager: true }, { path: 'lazy', bytes: 100, eager: false }], counts: { eagerModules: 2 }, bytes: { eager: 12 } };
const args = (bytes, modules) => ['--max-eager-bytes', String(bytes), '--max-eager-modules', String(modules)];
const run = (argv, input = JSON.stringify(report)) => spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8', timeout: 10000 });

test('boundary and violation matrix is deterministic', () => {
  for (const [bytes, modules, violations] of [[13, 3, []], [12, 2, []], [11, 2, ['eagerBytes']], [12, 1, ['eagerModules']], [0, 0, ['eagerBytes', 'eagerModules']]]) {
    const result = run(args(bytes, modules));
    assert.equal(result.status, violations.length ? 1 : 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: violations.length === 0, eagerBytes: 12, eagerModules: 2, maxEagerBytes: bytes, maxEagerModules: modules, violations });
    assert.equal(run(args(bytes, modules)).stdout, result.stdout);
  }
});

test('zero and largest safe integer are accepted, in either flag order', () => {
  for (const [fixture, argv, expected] of [
    [{ modules: [], counts: { eagerModules: 0 }, bytes: { eager: 0 } }, ['--max-eager-modules', '0', '--max-eager-bytes', '0'], { ok: true, eagerBytes: 0, eagerModules: 0, maxEagerBytes: 0, maxEagerModules: 0, violations: [] }],
    [{ modules: [{ path: 'large', bytes: Number.MAX_SAFE_INTEGER, eager: true }], counts: { eagerModules: 1 }, bytes: { eager: Number.MAX_SAFE_INTEGER } }, args(Number.MAX_SAFE_INTEGER, 1), { ok: true, eagerBytes: Number.MAX_SAFE_INTEGER, eagerModules: 1, maxEagerBytes: Number.MAX_SAFE_INTEGER, maxEagerModules: 1, violations: [] }],
  ]) {
    const result = run(argv, JSON.stringify(fixture));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test('invalid arguments fail closed without echoing input', () => {
  for (const argv of [[], ['--wrong', '1', '--max-eager-modules', '1'], ['--max-eager-bytes', '1', '--max-eager-bytes', '2'], ...['-1', '+1', ' 1', '1 ', '1e2', '1.0', '9007199254740992', 'secret'].map(value => args(value, 1)), [...args(1, 1), 'extra']]) {
    const result = run(argv);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'argv error\n');
  }
});

test('invalid and inconsistent reports fail closed', () => {
  const invalid = ['not json secret', 'null', '{}', JSON.stringify({ ...report, counts: { eagerModules: 1 } }), JSON.stringify({ ...report, bytes: { eager: 13 } }), JSON.stringify({ ...report, modules: [{ path: 'a', bytes: -1, eager: true }] }), JSON.stringify({ ...report, modules: [{ path: 'a', bytes: 5, eager: 'true' }] }), JSON.stringify({ ...report, modules: [{ path: 'a', bytes: 5, eager: true }, { path: 'a', bytes: 7, eager: true }] }), JSON.stringify({ modules: [{ path: 'a', bytes: Number.MAX_SAFE_INTEGER, eager: true }, { path: 'b', bytes: 1, eager: true }], counts: { eagerModules: 2 }, bytes: { eager: Number.MAX_SAFE_INTEGER } })];
  for (const input of invalid) {
    const result = run(args(100, 100), input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'report error\n');
  }
});

test('consumes real scanner output without modifying input files', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.env.HOME, 'limits-'));
  try {
    const entry = join(dir, 'entry.mjs');
    const source = "import './child.mjs';\n";
    const child = 'export default 1;\n';
    writeFileSync(entry, source);
    writeFileSync(join(dir, 'child.mjs'), child);
    const scan = spawnSync(process.execPath, [scanner, entry], { encoding: 'utf8', timeout: 10000 });
    assert.equal(scan.status, 0, scan.stderr);
    const result = run(args(40, 2), scan.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, eagerBytes: 40, eagerModules: 2, maxEagerBytes: 40, maxEagerModules: 2, violations: [] });
    assert.equal(readFileSync(entry, 'utf8'), source);
    assert.equal(readFileSync(join(dir, 'child.mjs'), 'utf8'), child);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
