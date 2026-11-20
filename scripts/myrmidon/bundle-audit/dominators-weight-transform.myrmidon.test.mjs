import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const edge = (from, to, specifier = `./${to}`, kind = 'eager') => ({ from, to, specifier, kind });
const graph = (names, edges, eager = names) => ({
  entry: names[0],
  modules: names.map((path, i) => ({ path, bytes: [2, 3, 5, 7, 11, 13][i], eager: eager.includes(path) })),
  edges,
});
const cases = [
  ['chain', graph(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')]), 'c'],
  ['diamond', graph(['a', 'b', 'c', 'd', 'e'], [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'e')]), 'e'],
  ['lazy and unreachable', graph(['a', 'b', 'c', 'x', 'y'], [edge('a', 'b'), edge('b', 'c'), edge('a', 'c', './lazy-c', 'lazy'), edge('a', 'x', './lazy-x', 'lazy'), edge('x', 'y'), edge('y', 'x')], ['a', 'b', 'c']), 'c'],
  ['aliases and cycle', graph(['a', 'b', 'c', 'd'], [edge('a', 'b', './one'), edge('a', 'b', './two'), edge('b', 'c'), edge('c', 'b'), edge('c', 'd')]), 'd'],
];

// Removing a vertex and traversing the remaining graph is independent of the CLI's dominator algorithm.
function reachable(report, target, removed) {
  if (report.entry === removed) return false;
  const seen = new Set();
  const queue = [report.entry];
  while (queue.length) {
    const current = queue.shift();
    if (current === removed || seen.has(current)) continue;
    seen.add(current);
    for (const e of report.edges) {
      if (e.from === current && e.kind === 'eager' && e.to !== null && e.to !== removed) queue.push(e.to);
    }
  }
  return seen.has(target);
}
function expected(report, target) {
  assert.ok(reachable(report, target, null));
  const dominators = report.modules.map(m => m.path)
    .filter(candidate => candidate === report.entry || candidate === target || !reachable(report, target, candidate))
    .sort();
  return { entry: report.entry, target, dominators };
}
function assertOutput(stdout, value) {
  assert.equal(stdout, `${JSON.stringify(value)}\n`);
}
function run(report, target) {
  const result = spawnSync(process.execPath, [cli, '-', target], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('dominator identities do not depend on affine module weights or input order', () => {
  for (const [name, base, target] of cases) {
    for (const selected of [base.entry, target]) {
      const oracle = expected(base, selected);
      assert.ok(oracle.dominators.length > 0, name);
      for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
        for (const reverseModules of [false, true]) for (const reverseEdges of [false, true]) {
          const modules = base.modules.map(m => ({ ...m, bytes: k * m.bytes + c }));
          const edges = [...base.edges];
          if (reverseModules) modules.reverse();
          if (reverseEdges) edges.reverse();
          const transformed = { ...base, modules, edges };
          assert.deepEqual(expected(transformed, selected), oracle, `${name}: oracle topology changed`);
          assertOutput(run(transformed, selected), oracle);
        }
      }
    }
  }
});

test('the same exact-output assertion rejects missing dominators and constant output', () => {
  for (const [, report, target] of cases) {
    const oracle = expected(report, target);
    const wrong = { ...oracle, dominators: oracle.dominators.slice(1) };
    assert.throws(() => assertOutput(`${JSON.stringify(wrong)}\n`, oracle), assert.AssertionError);
    assert.throws(() => assertOutput('{}\n', oracle), assert.AssertionError);
  }
});
