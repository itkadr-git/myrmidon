import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const core = [
  { path: 'core/a', bytes: 5, eager: true },
  { path: 'core/b', bytes: 7, eager: true },
];
const expectedCore = { ok: true, eagerBytes: 12, eagerModules: 2, maxEagerBytes: 12, maxEagerModules: 2, violations: [] };
const expectedPromoted = { ok: false, eagerBytes: 15, eagerModules: 3, maxEagerBytes: 12, maxEagerModules: 2, violations: ['eagerBytes', 'eagerModules'] };

function report(lazy) {
  return { modules: [...core, ...lazy], counts: { eagerModules: 2 }, bytes: { eager: 12 } };
}
function run(input) {
  return spawnSync(process.execPath, [cli, '--max-eager-bytes', '12', '--max-eager-modules', '2'], {
    input: JSON.stringify(input), encoding: 'utf8',
  });
}
function assertResult(result, status, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

test('lazy additions, permutations, renames and removal do not spend eager budget', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    path: `lazy/${i}`, bytes: i === 0 ? 0 : i === 1 ? Number.MAX_SAFE_INTEGER : i, eager: false,
  }));
  const variants = [[], [twenty[1]], twenty, [...twenty].reverse(), twenty.map((item, i) => ({ ...item, path: `renamed/${i}` })), []];
  for (const lazy of variants) assertResult(run(report(lazy)), 0, expectedCore);
});

test('promoting one lazy module spends eager budget', () => {
  const input = report([{ path: 'lazy/promoted', bytes: 3, eager: true }, { path: 'lazy/remaining', bytes: Number.MAX_SAFE_INTEGER, eager: false }]);
  input.counts.eagerModules = 3;
  input.bytes.eager = 15;
  assertResult(run(input), 1, expectedPromoted);
});

test('malformed lazy bytes are rejected without echoing the input', () => {
  const result = run(report([{ path: 'private-input-marker', bytes: -1, eager: false }]));
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'report error\n');
});

test('the output assertion rejects an incorrect independent expectation', () => {
  const result = run(report([]));
  assertResult(result, 0, expectedCore);
  assert.throws(() => assertResult(result, 0, { ...expectedCore, eagerBytes: 13 }), assert.AssertionError);
});
