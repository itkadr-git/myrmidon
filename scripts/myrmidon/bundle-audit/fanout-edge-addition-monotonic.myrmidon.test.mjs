import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const modules = [
  { path: 'entry', bytes: 10, eager: true },
  { path: 'a', bytes: 20, eager: true },
  { path: 'b', bytes: 30, eager: true },
  { path: 'c', bytes: 40, eager: false },
  { path: 'off', bytes: 50, eager: false },
  { path: 'z', bytes: 60, eager: false },
];
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const base = [edge('entry', 'a', 'eager', 'a'), edge('a', 'b', 'eager', 'b')];
const direct = edge('entry', 'b', 'eager', 'b');
const alias = edge('entry', 'b-alias', 'eager', 'b');
const lazy = edge('entry', 'c-lazy', 'lazy', 'c');
const unknown = edge('entry', 'unknown', 'eager', null);
const self = edge('entry', 'self', 'eager', 'entry');
const disconnected = edge('off', 'z', 'eager', 'z');

// These complete expected reports are independent of the CLI implementation.
const baseline = { entry: 'entry', modules: [
  { path: 'a', bytes: 20, targets: ['b'], fanOut: 1 },
  { path: 'entry', bytes: 10, targets: ['a'], fanOut: 1 },
  { path: 'b', bytes: 30, targets: [], fanOut: 0 },
  { path: 'c', bytes: 40, targets: [], fanOut: 0 },
  { path: 'off', bytes: 50, targets: [], fanOut: 0 },
  { path: 'z', bytes: 60, targets: [], fanOut: 0 },
] };
const added = { entry: 'entry', modules: [
  { path: 'entry', bytes: 10, targets: ['a', 'b'], fanOut: 2 },
  { path: 'a', bytes: 20, targets: ['b'], fanOut: 1 },
  { path: 'b', bytes: 30, targets: [], fanOut: 0 },
  { path: 'c', bytes: 40, targets: [], fanOut: 0 },
  { path: 'off', bytes: 50, targets: [], fanOut: 0 },
  { path: 'z', bytes: 60, targets: [], fanOut: 0 },
] };
const looped = { entry: 'entry', modules: [
  { path: 'entry', bytes: 10, targets: ['a', 'b', 'entry'], fanOut: 3 },
  { path: 'a', bytes: 20, targets: ['b'], fanOut: 1 },
  { path: 'b', bytes: 30, targets: [], fanOut: 0 },
  { path: 'c', bytes: 40, targets: [], fanOut: 0 },
  { path: 'off', bytes: 50, targets: [], fanOut: 0 },
  { path: 'z', bytes: 60, targets: [], fanOut: 0 },
] };
const offAdded = { entry: 'entry', modules: [
  { path: 'entry', bytes: 10, targets: ['a', 'b'], fanOut: 2 },
  { path: 'a', bytes: 20, targets: ['b'], fanOut: 1 },
  { path: 'off', bytes: 50, targets: ['z'], fanOut: 1 },
  { path: 'b', bytes: 30, targets: [], fanOut: 0 },
  { path: 'c', bytes: 40, targets: [], fanOut: 0 },
  { path: 'z', bytes: 60, targets: [], fanOut: 0 },
] };

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
}
function expectReport(edges, expected) {
  const report = { entry: 'entry', modules, edges };
  for (const input of [report, report, { ...report, modules: [...modules].reverse(), edges: [...edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
}

test('adding and removing a direct eager edge changes only its source', () => {
  expectReport(base, baseline);
  expectReport([...base, direct], added);
  expectReport([...base, direct].filter(item => item !== direct), baseline);
});
test('adding and removing an alias does not add a target', () => {
  expectReport([...base, direct], added);
  expectReport([...base, direct, alias], added);
  expectReport([...base, direct, alias].filter(item => item !== direct), added);
});
test('lazy and unknown edges do not count, but an eager self-loop does', () => {
  expectReport([...base, direct], added);
  expectReport([...base, direct, lazy, unknown], added);
  expectReport([...base, direct, lazy, unknown, self], looped);
});
test('adding a disconnected edge changes its source and rank', () => {
  expectReport([...base, direct], added);
  expectReport([...base, direct, disconnected], offAdded);
});
test('an absent endpoint is rejected without exposing input', () => {
  const result = run({ entry: 'entry', modules, edges: [...base, edge('entry', 'secret-specifier', 'eager', 'secret-absent-endpoint')] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
