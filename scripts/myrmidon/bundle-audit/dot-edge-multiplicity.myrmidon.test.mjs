import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});
const assertOutput = (result, expected) => {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
};

// Paths are already in code-point order; ids are deliberately fixed rather
// than derived from the CLI output or from production's sorting routine.
const paths = ['a', 'b', 'c', 'd', 'z"\\'];
const ids = { a: 'n0', b: 'n1', c: 'n2', d: 'n3', 'z"\\': 'n4' };
const labels = { a: 'a', b: 'b', c: 'c', d: 'd', 'z"\\': 'z\\"\\\\' };
const fixtures = [
  { name: 'chain', arcs: [['a', 'b', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'eager']] },
  { name: 'diamond with shared suffix', arcs: [['a', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'd', 'eager'], ['c', 'd', 'eager'], ['d', 'z"\\', 'eager']] },
  { name: 'cycle with exit', arcs: [['a', 'b', 'eager'], ['b', 'c', 'eager'], ['c', 'a', 'eager'], ['c', 'd', 'eager']] },
  { name: 'mixed and disconnected', arcs: [['a', 'b', 'eager'], ['a', 'c', 'lazy'], ['b', 'd', 'lazy'], ['c', 'd', 'eager']], unresolved: true },
];

// Compute reachability from the original relation, before alias expansion.
function eagerPaths(arcs) {
  const reached = new Set(['a']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to, kind] of arcs) {
      if (kind === 'eager' && reached.has(from) && !reached.has(to)) {
        reached.add(to);
        changed = true;
      }
    }
  }
  return reached;
}

function fixtureData(fixture, count) {
  const eager = eagerPaths(fixture.arcs);
  const modules = paths.map((path, i) => ({ path, bytes: 10 + i, eager: eager.has(path) }));
  const edges = [];
  const expectedEdges = [];
  // Arcs are specified in from/index order; the fixed prefix makes this also
  // the required lexical order, including aliases to the same target.
  fixture.arcs.forEach(([from, to, kind], index) => {
    for (let alias = 0; alias < count; alias++) {
      const specifier = `edge${index}-${alias}"\\`;
      edges.push({ from, to, kind, specifier });
      expectedEdges.push(`  ${ids[from]} -> ${ids[to]} [label="edge${index}-${alias}\\"\\\\", style=${kind === 'eager' ? 'solid' : 'dashed'}];`);
    }
  });
  if (fixture.unresolved) edges.push({ from: 'a', to: null, kind: 'lazy', specifier: 'unresolved' });
  const nodes = paths.map(path => `  ${ids[path]} [label="${labels[path]}", style=${eager.has(path) ? 'solid' : 'dashed'}];`);
  const expected = ['digraph imports {', ...nodes, ...expectedEdges, `  // unresolved: ${fixture.unresolved ? 1 : 0}`, '}', ''].join('\n');
  return { report: { entry: 'a', modules, edges }, expected };
}

for (const fixture of fixtures) {
  for (const count of [1, 2, 4]) {
    test(`${fixture.name}: ${count} aliases retain every tuple in either input order`, () => {
      const { report, expected } = fixtureData(fixture, count);
      assertOutput(run(report), expected);
      const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
      assertOutput(run(reversed), expected);
    });
  }
}

test('exact duplicate tuple fails closed, unlike parallel aliases', () => {
  const { report, expected } = fixtureData(fixtures[0], 2);
  assertOutput(run(report), expected);
  const duplicate = { ...report, edges: [...report.edges, { ...report.edges[0] }] };
  const result = run(duplicate);
  assert.equal(result.status, 1);
  assert.notEqual(result.stderr, '');
  assert.equal(result.stdout, '');
});

test('the output assertion rejects an extra edge in the expected result', () => {
  const { report, expected } = fixtureData(fixtures[1], 4);
  const result = run(report);
  assertOutput(result, expected);
  const corrupt = expected.replace('  // unresolved:', '  n0 -> n4 [label="extra", style=solid];\n  // unresolved:');
  assert.notEqual(corrupt, expected);
  assert.throws(() => assertOutput(result, corrupt), assert.AssertionError);
});
