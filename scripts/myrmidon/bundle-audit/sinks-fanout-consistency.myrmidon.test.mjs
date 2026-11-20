import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const sinks = process.env.MYRMIDON_TEST_SINKS_CLI || fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const fanout = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const mod = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to ?? 'external' });
const row = (path, bytes, targets) => ({ path, bytes, targets, fanOut: targets.length });

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return JSON.parse(result.stdout);
}

function check(input, entry, reachable, expectedFanout, expectedSinks, sinkBytes) {
  const actualFanout = run(fanout, [], input);
  const actualSinks = run(sinks, [], input);
  assert.deepEqual(actualFanout, { entry, modules: expectedFanout });
  assert.deepEqual(actualSinks, { entry, sinks: expectedSinks, sinkBytes });
  const zeroReachable = actualFanout.modules.filter(m => reachable.includes(m.path) && m.fanOut === 0)
    .map(({ path, bytes }) => ({ path, bytes })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(zeroReachable, expectedSinks);
}

test('independent eager closure agrees across chain, diamond and disconnected terminals', () => {
  const report = { entry: 'a', modules: [mod('a', 1), mod('b', 2), mod('c', 3), mod('d', 7), mod('z', 11)],
    edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')] };
  check(JSON.stringify(report), 'a', ['a', 'b', 'c', 'd'],
    [row('a', 1, ['b', 'c']), row('b', 2, ['d']), row('c', 3, ['d']), row('d', 7, []), row('z', 11, [])],
    [{ path: 'd', bytes: 7 }], 7);
  const chain = { entry: 'a', modules: [mod('a', 1), mod('b', 2), mod('c', 3)], edges: [edge('a', 'b'), edge('b', 'c')] };
  check(JSON.stringify(chain), 'a', ['a', 'b', 'c'], [row('a', 1, ['b']), row('b', 2, ['c']), row('c', 3, [])], [{ path: 'c', bytes: 3 }], 3);
});

test('self-loop is not a sink; lazy and external edges do not cancel an eager sink', () => {
  const loop = { entry: 'a', modules: [mod('a', 1), mod('b', 2)], edges: [edge('a', 'a'), edge('a', 'b', 'lazy'), edge('a', null)] };
  check(JSON.stringify(loop), 'a', ['a'], [row('a', 1, ['a']), row('b', 2, [])], [], 0);
  const lazy = { ...loop, edges: [edge('a', 'b', 'lazy'), edge('a', null)] };
  check(JSON.stringify(lazy), 'a', ['a'], [row('a', 1, []), row('b', 2, [])], [{ path: 'a', bytes: 1 }], 1);
});

test('scanner stdout feeds both consumers without executing fixture sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'sinks-fanout-'));
  try {
    const sentinel = join(dir, 'executed');
    const guard = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const sources = {
      'entry.mjs': `import './a.mjs';\nimport('./lazy.mjs');\n${guard}`,
      'a.mjs': `import './end.mjs';\n${guard}`,
      'end.mjs': guard,
      'lazy.mjs': guard,
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
    const scanned = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(scanned.error, undefined);
    assert.equal(scanned.signal, null);
    assert.equal(scanned.status, 0, scanned.stderr);
    assert.equal(scanned.stderr, '');
    JSON.parse(scanned.stdout);
    assert.equal(existsSync(sentinel), false);
    const bytes = name => Buffer.byteLength(sources[name]);
    check(scanned.stdout, 'entry.mjs', ['entry.mjs', 'a.mjs', 'end.mjs'],
      [row('a.mjs', bytes('a.mjs'), ['end.mjs']), row('entry.mjs', bytes('entry.mjs'), ['a.mjs']), row('end.mjs', bytes('end.mjs'), []), row('lazy.mjs', bytes('lazy.mjs'), [])],
      [{ path: 'end.mjs', bytes: bytes('end.mjs') }], bytes('end.mjs'));
    assert.equal(existsSync(sentinel), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
