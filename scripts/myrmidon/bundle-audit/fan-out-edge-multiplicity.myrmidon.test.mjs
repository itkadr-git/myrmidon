import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fixtures = [
  { name: 'chain', paths: ['a', 'b', 'c'], edges: [['a', 'b', 'eager'], ['b', 'c', 'eager']] },
  { name: 'diamond with shared suffix', paths: ['a', 'B', 'b', 'c', 'd'], edges: [['a', 'B', 'eager'], ['a', 'b', 'eager'], ['B', 'c', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'eager']] },
  { name: 'cycle with exit and self-loop', paths: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['b', 'a', 'eager'], ['b', 'b', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'eager']] },
  { name: 'mixed and disconnected', paths: ['a', 'b', 'c', 'off', 'end'], edges: [['a', 'b', 'eager'], ['a', 'c', 'lazy'], ['b', null, 'eager'], ['b', null, 'lazy'], ['off', 'end', 'eager'], ['end', 'end', 'eager']] },
];

function makeReport(fixture, count, reversed) {
  const reachable = new Set(['a']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to, kind] of fixture.edges) {
      if (kind === 'eager' && to !== null && reachable.has(from) && !reachable.has(to)) {
        reachable.add(to);
        changed = true;
      }
    }
  }
  const modules = fixture.paths.map((path, index) => ({ path, bytes: index + 1, eager: reachable.has(path) }));
  const edges = fixture.edges.flatMap(([from, to, kind], index) =>
    Array.from({ length: to === null ? 1 : count }, (_, alias) => ({ from, specifier: `edge-${index}-alias-${alias}`, kind, to })));
  return { entry: 'a', modules: reversed ? modules.reverse() : modules, edges: reversed ? edges.reverse() : edges };
}

function oracle(fixture) {
  const modules = fixture.paths.map((path, index) => {
    const targets = [...new Set(fixture.edges.filter(([from, to, kind]) => from === path && to !== null && kind === 'eager').map(([, to]) => to))].sort(cmp);
    return { path, bytes: index + 1, targets, fanOut: targets.length };
  });
  modules.sort((a, b) => b.fanOut - a.fanOut || cmp(a.path, b.path));
  return { entry: 'a', modules };
}

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
}
function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

for (const fixture of fixtures) {
  test(`${fixture.name}: direct targets are independent of import tuple multiplicity and ordering`, () => {
    const expected = oracle(fixture);
    assert.ok(expected.modules.some(module => module.fanOut > 0));
    for (const count of [1, 2, 4]) {
      for (const reversed of [false, true]) {
        assertOutput(run(makeReport(fixture, count, reversed)), expected);
      }
    }
  });
}

test('an exact duplicate tuple is rejected, unlike distinct aliases', () => {
  const report = makeReport(fixtures[0], 2, false);
  assertOutput(run(report), oracle(fixtures[0]));
  report.edges.push({ ...report.edges[0] });
  const result = run(report);
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('the output assertion rejects a corrupted expected result', () => {
  const fixture = fixtures[0];
  const result = run(makeReport(fixture, 4, false));
  const expected = oracle(fixture);
  assertOutput(result, expected);
  expected.modules[0].bytes += 1;
  assert.throws(() => assertOutput(result, expected), assert.AssertionError);
});
