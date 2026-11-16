import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));

function run(report, maxBytes, maxModules, reverse = false) {
  const bytes = ['--max-eager-bytes', String(maxBytes)];
  const modules = ['--max-eager-modules', String(maxModules)];
  return spawnSync(process.execPath, [cli, ...(reverse ? [...modules, ...bytes] : [...bytes, ...modules])], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
  });
}

function expected(eagerBytes, eagerModules, maxEagerBytes, maxEagerModules) {
  const violations = [
    ...(maxEagerBytes < eagerBytes ? ['eagerBytes'] : []),
    ...(maxEagerModules < eagerModules ? ['eagerModules'] : []),
  ];
  return { ok: violations.length === 0, eagerBytes, eagerModules, maxEagerBytes, maxEagerModules, violations };
}

function check(report, eagerBytes, eagerModules, maxBytes, maxModules, reverse) {
  const result = run(report, maxBytes, maxModules, reverse);
  const oracle = expected(eagerBytes, eagerModules, maxBytes, maxModules);
  assert.equal(result.error, undefined);
  assert.equal(result.status, oracle.ok ? 0 : 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(oracle)}\n`);
}

test('independent threshold matrix for 30 deterministic reports', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const eagerModules = 1 + seed % 5;
    const eagerBytes = seed * eagerModules;
    const modules = Array.from({ length: eagerModules }, (_, i) => ({ path: `eager-${i}`, bytes: seed, eager: true }));
    modules.push({ path: 'eager-zero', bytes: 0, eager: true }, { path: 'lazy', bytes: seed * 11, eager: false }, { path: 'lazy-zero', bytes: 0, eager: false });
    const count = eagerModules + 1;
    const report = { modules, counts: { eagerModules: count }, bytes: { eager: eagerBytes } };
    for (const maxBytes of [eagerBytes - 1, eagerBytes, eagerBytes + 1]) {
      for (const maxModules of [count - 1, count, count + 1]) {
        for (const reverse of [false, true]) check(report, eagerBytes, count, maxBytes, maxModules, reverse);
      }
    }
  }
});

test('safe integer sum is accepted and overflow is rejected', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const modules = [{ path: 'large', bytes: max - 1, eager: true }, { path: 'one', bytes: 1, eager: true }, { path: 'lazy', bytes: max, eager: false }];
  const report = { modules, counts: { eagerModules: 2 }, bytes: { eager: max } };
  for (const reverse of [false, true]) check(report, max, 2, max, 2, reverse);
  const overflow = { ...report, modules: [...modules, { path: 'overflow', bytes: 1, eager: true }], counts: { eagerModules: 3 } };
  const result = run(overflow, max, 3);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'report error\n');
});
