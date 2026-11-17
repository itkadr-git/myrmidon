import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const records = [
  { path: 'alpha', bytes: 5, eager: true },
  { path: 'beta', bytes: 11, eager: true },
  { path: 'gamma', bytes: 23, eager: false },
  { path: 'delta', bytes: 47, eager: false },
];
const cases = [
  { bytes: 16, modules: 2, expected: { ok: true, eagerBytes: 16, eagerModules: 2, maxEagerBytes: 16, maxEagerModules: 2, violations: [] } },
  { bytes: 15, modules: 2, expected: { ok: false, eagerBytes: 16, eagerModules: 2, maxEagerBytes: 15, maxEagerModules: 2, violations: ['eagerBytes'] } },
  { bytes: 16, modules: 1, expected: { ok: false, eagerBytes: 16, eagerModules: 2, maxEagerBytes: 16, maxEagerModules: 1, violations: ['eagerModules'] } },
  { bytes: 15, modules: 1, expected: { ok: false, eagerBytes: 16, eagerModules: 2, maxEagerBytes: 15, maxEagerModules: 1, violations: ['eagerBytes', 'eagerModules'] } },
];

function permutations(items) {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest]));
}

function checkResult(result, expected) {
  assert.equal(result.signal, null);
  assert.equal(result.status, expected.ok ? 0 : 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

function run(argv, input) {
  return spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8' });
}

test('record, flag and JSON serialization order do not change budget verdicts', () => {
  const orders = permutations(records);
  assert.equal(orders.length, 24);
  for (const { bytes, modules, expected } of cases) {
    const flags = [['--max-eager-bytes', String(bytes)], ['--max-eager-modules', String(modules)]];
    let baseline;
    for (const order of orders) {
      const ordinary = { modules: order, counts: { eagerModules: 2 }, bytes: { eager: 16 } };
      const reordered = { bytes: { eager: 16 }, counts: { eagerModules: 2 }, modules: order.map(({ path, bytes: size, eager }) => ({ eager, bytes: size, path })) };
      for (const input of [JSON.stringify(ordinary), JSON.stringify(reordered, null, 2)]) {
        for (const flagOrder of [flags, [...flags].reverse()]) {
          const result = run(flagOrder.flat(), input);
          checkResult(result, expected);
          baseline ??= result.stdout;
          assert.equal(result.stdout, baseline);
        }
      }
    }
  }
});

test('the oracle detects a dropped eager record', () => {
  const flags = ['--max-eager-bytes', '16', '--max-eager-modules', '2'];
  const reduced = { modules: records.slice(1), counts: { eagerModules: 1 }, bytes: { eager: 11 } };
  const result = run(flags, JSON.stringify(reduced));
  checkResult(result, { ok: true, eagerBytes: 11, eagerModules: 1, maxEagerBytes: 16, maxEagerModules: 2, violations: [] });
  assert.throws(() => checkResult(result, cases[0].expected), assert.AssertionError);
});

test('inconsistent totals fail closed without exposing input', () => {
  const input = JSON.stringify({ modules: records.slice(1), counts: { eagerModules: 2 }, bytes: { eager: 16 }, marker: 'private-input-marker' });
  const result = run(['--max-eager-bytes', '16', '--max-eager-modules', '2'], input);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'report error\n');
  assert.doesNotMatch(result.stderr, /private-input-marker/);
});
