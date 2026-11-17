import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const fixtures = [
  { name: 'chain', nodes: [['entry', 2], ['a', 3], ['b', 5]], links: [['entry', 'a', 'eager'], ['a', 'b', 'eager']] },
  { name: 'diamond with cycle', nodes: [['entry', 2], ['a', 3], ['b', 5], ['shared', 7]], links: [['entry', 'a', 'eager'], ['entry', 'b', 'eager'], ['a', 'shared', 'eager'], ['b', 'shared', 'eager'], ['shared', 'a', 'eager']] },
  { name: 'lazy and disconnected', nodes: [['entry', 2], ['a', 3], ['lazy', 5], ['off', 7], ['offChild', 11]], links: [['entry', 'a', 'eager'], ['entry', 'lazy', 'lazy'], ['off', 'offChild', 'eager']] },
  { name: 'mixed eager and lazy', nodes: [['entry', 2], ['a', 3], ['b', 5], ['c', 7], ['isolated', 11]], links: [['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['entry', 'b', 'lazy'], ['b', 'c', 'eager'], ['a', 'c', 'lazy'], ['isolated', 'c', 'eager']] },
];

// Traverse fixture links directly, independently of the CLI and expanded report.
function reachable(fixture, removed = null) {
  const found = new Set();
  const queue = fixture.nodes[0][0] === removed ? [] : [fixture.nodes[0][0]];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (found.has(current)) continue;
    found.add(current);
    for (const [from, to, kind] of fixture.links) {
      if (kind === 'eager' && from === current && to !== removed && !found.has(to)) queue.push(to);
    }
  }
  return found;
}

function expected(fixture, removed) {
  const before = reachable(fixture);
  const after = reachable(fixture, removed);
  const lostPaths = [...before].filter(path => !after.has(path)).sort();
  const bytes = new Map(fixture.nodes);
  return { entry: fixture.nodes[0][0], removed, lostPaths, lostBytes: lostPaths.reduce((sum, path) => sum + bytes.get(path), 0) };
}

function report(fixture, multiplicity, reverse) {
  const eager = reachable(fixture);
  const modules = fixture.nodes.map(([path, bytes]) => ({ path, bytes, eager: eager.has(path) }));
  const edges = fixture.links.flatMap(([from, to, kind], index) => Array.from({ length: multiplicity }, (_, alias) => ({ from, to, kind, specifier: `edge-${index}-alias-${alias}` })));
  return { entry: fixture.nodes[0][0], modules: reverse ? modules.reverse() : modules, edges: reverse ? edges.reverse() : edges };
}

function run(input, removed) {
  return spawnSync(process.execPath, [cli, removed], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
}

function assertResult(result, oracle) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), oracle);
}

for (const fixture of fixtures) {
  test(`${fixture.name}: parallel specifiers preserve every vertex cut`, () => {
    for (const multiplicity of [1, 2, 4]) {
      for (const reverse of [false, true]) {
        const input = report(fixture, multiplicity, reverse);
        for (const [removed] of fixture.nodes) assertResult(run(input, removed), expected(fixture, removed));
      }
    }
  });
}

test('exact duplicate edge tuple is rejected', () => {
  const input = report(fixtures[0], 2, false);
  input.edges.push({ ...input.edges[0] });
  const result = run(input, 'entry');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});

test('oracle assertion rejects duplicate paths, incorrect bytes and constant output', () => {
  const oracle = expected(fixtures[1], 'entry');
  const fake = value => ({ status: 0, stderr: '', stdout: JSON.stringify(value) });
  assert.throws(() => assertResult(fake({ ...oracle, lostPaths: [...oracle.lostPaths, oracle.lostPaths[0]] }), oracle));
  assert.throws(() => assertResult(fake({ ...oracle, lostBytes: oracle.lostBytes + 1 }), oracle));
  assert.throws(() => assertResult(fake({ entry: 'entry', removed: 'entry', lostPaths: [], lostBytes: 0 }), oracle));
});
