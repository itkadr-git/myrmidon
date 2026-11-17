import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const moduleRow = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  assert.equal(JSON.stringify(report), original);
}

test('subdividing an eager edge replaces its direct target', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 2, true), moduleRow('w', 3, true)], edges: [edge('u', 'to-v', 'eager', 'v'), edge('v', 'to-w', 'eager', 'w')] };
  const transformed = { entry: 'u', modules: [...baseline.modules, moduleRow('x', 4, true)], edges: [edge('u', 'to-x', 'eager', 'x'), edge('x', 'to-v', 'eager', 'v'), edge('v', 'to-w', 'eager', 'w')] };
  check(baseline, { entry: 'u', modules: [{ path: 'u', bytes: 1, targets: ['v'], fanOut: 1 }, { path: 'v', bytes: 2, targets: ['w'], fanOut: 1 }, { path: 'w', bytes: 3, targets: [], fanOut: 0 }] });
  check(transformed, { entry: 'u', modules: [{ path: 'u', bytes: 1, targets: ['x'], fanOut: 1 }, { path: 'v', bytes: 2, targets: ['w'], fanOut: 1 }, { path: 'x', bytes: 4, targets: ['v'], fanOut: 1 }, { path: 'w', bytes: 3, targets: [], fanOut: 0 }] });
});

test('subdividing one alias retains the other direct target', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 2, true)], edges: [edge('u', 'first', 'eager', 'v'), edge('u', 'second', 'eager', 'v')] };
  const transformed = { entry: 'u', modules: [...baseline.modules, moduleRow('x', 3, true)], edges: [edge('u', 'second', 'eager', 'v'), edge('u', 'to-x', 'eager', 'x'), edge('x', 'to-v', 'eager', 'v')] };
  check(baseline, { entry: 'u', modules: [{ path: 'u', bytes: 1, targets: ['v'], fanOut: 1 }, { path: 'v', bytes: 2, targets: [], fanOut: 0 }] });
  check(transformed, { entry: 'u', modules: [{ path: 'u', bytes: 1, targets: ['v', 'x'], fanOut: 2 }, { path: 'x', bytes: 3, targets: ['v'], fanOut: 1 }, { path: 'v', bytes: 2, targets: [], fanOut: 0 }] });
});

test('a lazy intermediary does not create an eager target for its importer', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 2, false)], edges: [edge('u', 'to-v', 'lazy', 'v')] };
  const transformed = { entry: 'u', modules: [...baseline.modules, moduleRow('x', 3, false)], edges: [edge('u', 'to-x', 'lazy', 'x'), edge('x', 'to-v', 'eager', 'v')] };
  check(baseline, { entry: 'u', modules: [{ path: 'u', bytes: 1, targets: [], fanOut: 0 }, { path: 'v', bytes: 2, targets: [], fanOut: 0 }] });
  check(transformed, { entry: 'u', modules: [{ path: 'x', bytes: 3, targets: ['v'], fanOut: 1 }, { path: 'u', bytes: 1, targets: [], fanOut: 0 }, { path: 'v', bytes: 2, targets: [], fanOut: 0 }] });
});

test('rejects a subdivision whose new endpoint is absent', () => {
  const report = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 2, true)], edges: [edge('u', 'to-x', 'eager', 'x'), edge('x', 'to-v', 'eager', 'v')] };
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
