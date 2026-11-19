import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const fixtures = [
  ['empty', []],
  ['eager', [{ path: 'a', bytes: 5, eager: true }, { path: 'b', bytes: 7, eager: true }]],
  ['mixed', [{ path: 'a', bytes: 5, eager: true }, { path: 'lazy', bytes: 100, eager: false }, { path: 'b', bytes: 7, eager: true }]],
  ['lazy', [{ path: 'lazy-a', bytes: 4, eager: false }, { path: 'lazy-b', bytes: 19, eager: false }]],
];
const args = (bytes, modules) => ['--max-eager-bytes', String(bytes), '--max-eager-modules', String(modules)];
const run = (argv, input) => spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8' });

function assertResult(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected.ok ? 0 : 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

for (const [name, original] of fixtures) {
  test(`affine eager budget boundaries: ${name}`, () => {
    const eager = original.filter(module => module.eager);
    const baseBytes = eager.reduce((sum, module) => sum + module.bytes, 0);
    const count = eager.length;
    for (const k of [0, 1, 3]) {
      for (const c of [0, 2, 11]) {
        const bytes = k * baseBytes + c * count;
        const report = {
          modules: original.map(module => ({ ...module, bytes: k * module.bytes + c })),
          counts: { eagerModules: count },
          bytes: { eager: bytes },
        };
        for (const maxBytes of [bytes - 1, bytes, bytes + 1].filter(value => value >= 0)) {
          for (const maxModules of [count - 1, count].filter(value => value >= 0)) {
            const violations = [];
            if (bytes > maxBytes) violations.push('eagerBytes');
            if (count > maxModules) violations.push('eagerModules');
            const expected = { ok: violations.length === 0, eagerBytes: bytes, eagerModules: count, maxEagerBytes: maxBytes, maxEagerModules: maxModules, violations };
            assertResult(run(args(maxBytes, maxModules), JSON.stringify(report)), expected);
          }
        }
      }
    }
  });
}

test('the result assertion rejects an incorrect oracle', () => {
  const report = { modules: [{ path: 'a', bytes: 5, eager: true }], counts: { eagerModules: 1 }, bytes: { eager: 5 } };
  const result = run(args(5, 1), JSON.stringify(report));
  const expected = { ok: true, eagerBytes: 5, eagerModules: 1, maxEagerBytes: 5, maxEagerModules: 1, violations: [] };
  assertResult(result, expected);
  assert.throws(() => assertResult(result, { ...expected, eagerBytes: 6 }), assert.AssertionError);
});

test('invalid transformed totals fail closed without echoing input', () => {
  const input = JSON.stringify({ modules: [{ path: 'private-marker', bytes: 8, eager: true }], counts: { eagerModules: 1 }, bytes: { eager: 7 } });
  const result = run(args(8, 1), input);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'report error\n');
});
