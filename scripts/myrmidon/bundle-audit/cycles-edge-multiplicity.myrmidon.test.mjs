import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cycles.mjs', import.meta.url));
const fixtures = [
  { name: 'chain', nodes: ['a', 'b', 'c'], edges: [['a', 'b', 'eager'], ['b', 'c', 'eager']] },
  { name: 'diamond', nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'd', 'eager'], ['c', 'd', 'eager']] },
  { name: 'lazy closure and disconnected self-loop', nodes: ['a', 'b', 'c', 'x'], edges: [['a', 'b', 'eager'], ['b', 'c', 'lazy'], ['c', 'a', 'lazy'], ['x', 'x', 'eager']] },
  { name: 'mixed eager and lazy cycles', nodes: ['a', 'b', 'c', 'd', 'e'], edges: [['a', 'b', 'eager'], ['b', 'a', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'lazy'], ['d', 'c', 'eager'], ['e', 'e', 'lazy']] },
];

function reachable(start, edges, eagerOnly) {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    const node = pending.pop();
    for (const [from, to, kind] of edges) {
      if (from === node && (!eagerOnly || kind === 'eager') && !seen.has(to)) {
        seen.add(to);
        pending.push(to);
      }
    }
  }
  return seen;
}

// Mutual reachability is deliberately independent of the CLI's SCC algorithm.
function cycleOracle(nodes, edges, eagerOnly) {
  const reach = new Map(nodes.map(node => [node, reachable(node, edges, eagerOnly)]));
  const remaining = new Set(nodes);
  const cycles = [];
  for (const node of [...nodes].sort()) {
    if (!remaining.has(node)) continue;
    const component = [...remaining].filter(other => reach.get(node).has(other) && reach.get(other).has(node)).sort();
    for (const member of component) remaining.delete(member);
    if (component.length > 1 || edges.some(([from, to, kind]) => from === node && to === node && (!eagerOnly || kind === 'eager'))) cycles.push(component);
  }
  return cycles;
}

function reportFor(fixture, multiplicity, reverse) {
  const eager = reachable('a', fixture.edges, true);
  const modules = fixture.nodes.map((path, index) => ({ path, bytes: 10 + index, eager: eager.has(path) }));
  const edges = fixture.edges.flatMap(([from, to, kind], edgeIndex) =>
    Array.from({ length: multiplicity }, (_, i) => ({ from, to, kind, specifier: `edge-${edgeIndex}-specifier-${i}` })));
  if (reverse) { modules.reverse(); edges.reverse(); }
  return { entry: 'a', modules, edges };
}

function expectedFor(fixture) {
  return { entry: 'a', eagerCycles: cycleOracle(fixture.nodes, fixture.edges, true), allCycles: cycleOracle(fixture.nodes, fixture.edges, false) };
}

function assertOutput(actual, expected) {
  assert.deepStrictEqual(actual, expected);
}

function run(report) {
  return spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}

for (const fixture of fixtures) {
  test(`${fixture.name}: parallel specifiers preserve exact cycles`, () => {
    const expected = expectedFor(fixture);
    for (const multiplicity of [1, 2, 4]) {
      for (const reverse of [false, true]) {
        const report = reportFor(fixture, multiplicity, reverse);
        assert.equal(new Set(report.edges.map(e => JSON.stringify([e.from, e.specifier, e.kind, e.to]))).size, report.edges.length);
        const result = run(report);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assertOutput(JSON.parse(result.stdout), expected);
      }
    }
  });
}

test('oracle distinguishes lazy closures and self-loops', () => {
  assert.deepStrictEqual(expectedFor(fixtures[2]), { entry: 'a', eagerCycles: [['x']], allCycles: [['a', 'b', 'c'], ['x']] });
  assert.deepStrictEqual(expectedFor(fixtures[3]), { entry: 'a', eagerCycles: [['a', 'b']], allCycles: [['a', 'b'], ['c', 'd'], ['e']] });
});

test('assertion rejects missing and duplicate cycle components', () => {
  const expected = expectedFor(fixtures[3]);
  for (const incorrect of [
    { ...expected, allCycles: expected.allCycles.slice(1) },
    { ...expected, allCycles: [...expected.allCycles, expected.allCycles[0]] },
    { ...expected, eagerCycles: [], allCycles: [] },
  ]) assert.throws(() => assertOutput(incorrect, expected), assert.AssertionError);
});

test('an exact duplicate edge tuple is rejected', () => {
  const report = reportFor(fixtures[2], 4, false);
  report.edges.push({ ...report.edges[0] });
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FAIL: duplicate\n');
});
