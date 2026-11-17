import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-explain.mjs', import.meta.url));
const fixtures = [
  { name: 'chain', vertices: ['entry', 'a', 'target'], arcs: [['entry', 'a'], ['a', 'target']] },
  { name: 'diamond with shared suffix', vertices: ['entry', 'Z', 'a', 'join', 'target'], arcs: [['entry', 'a'], ['entry', 'Z'], ['a', 'join'], ['Z', 'join'], ['join', 'target']] },
  { name: 'cycle with exit', vertices: ['entry', 'a', 'b', 'target'], arcs: [['entry', 'a'], ['a', 'b'], ['b', 'entry'], ['b', 'target'], ['a', 'target']] },
  { name: 'mixed', vertices: ['entry', 'a', 'target', 'lazy', 'disconnected'], arcs: [['entry', 'a'], ['a', 'target'], ['entry', 'lazy', 'lazy'], ['lazy', 'disconnected'], ['a', null], ['target', 'lazy', 'lazy']] },
];

// Enumerate simple paths from the original relation, independent of report ordering and aliases.
function paths(entry, target, arcs) {
  const found = [];
  function visit(path) {
    const last = path[path.length - 1];
    if (last === target) { found.push(path); return; }
    for (const [from, to, kind = 'eager'] of arcs) {
      if (from === last && to !== null && kind === 'eager' && !path.includes(to)) visit([...path, to]);
    }
  }
  visit([entry]);
  return found;
}
function sequenceCompare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
function expected(fixture, target) {
  const candidates = paths('entry', target, fixture.arcs);
  candidates.sort((a, b) => a.length - b.length || sequenceCompare(a, b));
  const path = candidates[0] ?? [];
  return { entry: 'entry', target, reachable: path.length > 0, path };
}
function report(fixture, count, reverse) {
  const modules = fixture.vertices.map((path, index) => ({ path, bytes: 11 + index * 7, eager: paths('entry', path, fixture.arcs).length > 0 }));
  const edges = fixture.arcs.flatMap(([from, to, kind = 'eager'], index) =>
    Array.from({ length: to === null ? 1 : count }, (_, alias) => ({ from, to, kind, specifier: `edge-${index}-alias-${alias}` })));
  return { entry: 'entry', modules: reverse ? modules.reverse() : modules, edges: reverse ? edges.reverse() : edges };
}
function run(input, target) {
  return spawnSync(process.execPath, [cli, '-', target], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
}
function assertOutput(result, wanted) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(wanted) + '\n');
}

test('parallel import tuples preserve explain output for all vertices and permutations', () => {
  for (const fixture of fixtures) {
    for (const count of [1, 2, 4]) {
      for (const reverse of [false, true]) {
        const input = report(fixture, count, reverse);
        assert.equal(input.modules.length, fixture.vertices.length);
        assert.equal(input.modules.reduce((sum, item) => sum + item.bytes, 0), fixture.vertices.reduce((sum, _, i) => sum + 11 + i * 7, 0));
        assert.equal(input.edges.length, fixture.arcs.reduce((sum, [, to]) => sum + (to === null ? 1 : count), 0));
        assert.equal(new Set(input.edges.map(edge => JSON.stringify([edge.from, edge.specifier, edge.kind, edge.to]))).size, input.edges.length);
        for (const target of fixture.vertices) {
          assertOutput(run(input, target), expected(fixture, target));
        }
      }
    }
  }
});

test('assertion rejects a corrupted expected path', () => {
  const fixture = fixtures[1];
  const wanted = expected(fixture, 'target');
  assert.deepEqual(wanted.path, ['entry', 'Z', 'join', 'target']);
  const actual = run(report(fixture, 4, false), 'target');
  assertOutput(actual, wanted);
  assert.throws(() => assertOutput(actual, { ...wanted, path: [...wanted.path, 'extra'] }), assert.AssertionError);
});

test('an exact duplicate tuple fails without partial stdout', () => {
  const input = report(fixtures[0], 4, false);
  input.edges.push({ ...input.edges[0] });
  const result = run(input, 'target');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: report\n');
});
