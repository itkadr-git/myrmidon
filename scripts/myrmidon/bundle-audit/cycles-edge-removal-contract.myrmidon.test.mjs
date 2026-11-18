import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cycles.mjs', import.meta.url));
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const ab = edge('a', 'b', './b');
const bc = edge('b', 'c', './c');
const ca = edge('c', 'a', './a');
const ac = edge('a', 'c', './c');
const ba = edge('b', 'a', './a');
const loop = edge('a', 'a', './a');
const lazy = edge('c', 'a', './a', 'lazy');
const unknown = edge('a', null, 'unknown-secret');
const alias = edge('c', 'a', 'alias-a');
const empty = { entry: 'a', eagerCycles: [], allCycles: [] };
const triangle = { entry: 'a', eagerCycles: [['a', 'b', 'c']], allCycles: [['a', 'b', 'c']] };
const pair = { entry: 'a', eagerCycles: [['a', 'c']], allCycles: [['a', 'c']] };
const singleton = { entry: 'a', eagerCycles: [['a']], allCycles: [['a']] };
const lazyTriangle = { entry: 'a', eagerCycles: [], allCycles: [['a', 'b', 'c']] };

// Eager reachability is specified independently for each transition.
const cases = [
  { name: 'unique eager triangle closure', paths: ['a', 'b', 'c'], edges: [ab, bc, ca], removed: ca, before: triangle, after: empty, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'b', 'c'] },
  { name: 'alternate closure keeps a cycle', paths: ['a', 'b', 'c'], edges: [ab, bc, ca, ac, ba], removed: ba, before: triangle, after: triangle, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'b', 'c'] },
  { name: 'self-loop removal retains its module', paths: ['a'], edges: [loop], removed: loop, before: singleton, after: empty, beforeEager: ['a'], afterEager: ['a'] },
  { name: 'lazy closure affects only all cycles', paths: ['a', 'b', 'c'], edges: [ab, bc, lazy], removed: lazy, before: lazyTriangle, after: empty, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'b', 'c'] },
  { name: 'unknown import does not affect cycles', paths: ['a', 'b', 'c'], edges: [ab, bc, ca, unknown], removed: unknown, before: triangle, after: triangle, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'b', 'c'] },
  { name: 'remaining alias preserves closure', paths: ['a', 'b', 'c'], edges: [ab, bc, ca, alias], removed: ca, before: triangle, after: triangle, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'b', 'c'] },
  { name: 'removing reachability edge updates eager flags', paths: ['a', 'b', 'c'], edges: [ab, ac, ca], removed: ab, before: pair, after: pair, beforeEager: ['a', 'b', 'c'], afterEager: ['a', 'c'] },
];

function run(report, expected) {
  const input = JSON.stringify(report);
  const result = spawnSync(process.execPath, [cli, '-'], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  assert.equal(JSON.stringify(report), input);
}

for (const scenario of cases) {
  test(scenario.name, () => {
    const modules = eager => scenario.paths.map((path, index) => ({ path, bytes: (index + 1) * 10, eager: eager.includes(path) }));
    const before = { entry: 'a', modules: modules(scenario.beforeEager), edges: [...scenario.edges] };
    const after = { entry: 'a', modules: modules(scenario.afterEager), edges: scenario.edges.filter(e => e !== scenario.removed) };
    const original = JSON.stringify(before);
    const restored = { ...after, modules: modules(scenario.beforeEager), edges: [...after.edges, scenario.removed] };
    for (const [report, expected] of [[before, scenario.before], [after, scenario.after], [restored, scenario.before]]) {
      run(report, expected);
      run(report, expected);
      run({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, expected);
    }
    assert.equal(JSON.stringify(before), original);
    assert.deepEqual(after.modules.map(({ path, bytes }) => ({ path, bytes })), before.modules.map(({ path, bytes }) => ({ path, bytes })));
  });
}

test('missing edge endpoint fails without disclosing input', () => {
  const report = { entry: 'a', modules: [{ path: 'a', bytes: 10, eager: true }], edges: [edge('a', 'secret-missing-endpoint', 'secret-specifier')] };
  const original = JSON.stringify(report);
  const result = spawnSync(process.execPath, [cli, '-'], { input: original, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FAIL: reference\n');
  assert.equal(JSON.stringify(report), original);
});
