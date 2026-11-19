import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dominators.mjs', import.meta.url));
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${from}-${to}-${kind}` });
const report = (names, edges) => ({ entry: 'e', modules: names.map(path => ({ path, bytes: 0, eager: true })), edges });
const run = input => spawnSync(process.execPath, [cli, '-', 't'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
const distractors = [edge('e', 't', 'lazy'), edge('e', null)];

function check(input, dominators) {
  const snapshot = JSON.stringify(input);
  const expected = JSON.stringify({ entry: 'e', target: 't', dominators }) + '\n';
  for (const graph of [input, input, { ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }]) {
    const result = run(graph);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  }
  assert.equal(JSON.stringify(input), snapshot);
}

test('subdivide a chain with lazy and unknown bypasses', () => {
  const baseline = report(['e', 'a', 't'], [edge('e', 'a'), edge('a', 't'), ...distractors]);
  const transformed = report(['e', 'a', 't', 'x'], [edge('e', 'x'), edge('x', 'a'), edge('a', 't'), ...distractors]);
  check(baseline, ['a', 'e', 't']);
  check(transformed, ['a', 'e', 't', 'x']);
  const eagerBypass = { ...transformed, edges: [...transformed.edges, edge('e', 't')] };
  check(eagerBypass, ['e', 't']);
});

test('subdivide one diamond branch', () => {
  const baseline = report(['e', 'a', 'b', 't'], [edge('e', 'a'), edge('a', 't'), edge('e', 'b'), edge('b', 't'), ...distractors]);
  const transformed = report(['e', 'a', 'b', 't', 'x'], [edge('e', 'x'), edge('x', 'a'), edge('a', 't'), edge('e', 'b'), edge('b', 't'), ...distractors]);
  check(baseline, ['e', 't']);
  check(transformed, ['e', 't']);
});

test('subdivide the common stem before a diamond', () => {
  const baseline = report(['e', 's', 'a', 'b', 't'], [edge('e', 's'), edge('s', 'a'), edge('s', 'b'), edge('a', 't'), edge('b', 't'), ...distractors]);
  const transformed = report(['e', 's', 'a', 'b', 't', 'x'], [edge('e', 'x'), edge('x', 's'), edge('s', 'a'), edge('s', 'b'), edge('a', 't'), edge('b', 't'), ...distractors]);
  check(baseline, ['e', 's', 't']);
  check(transformed, ['e', 's', 't', 'x']);
});

test('reject a subdivided graph with a missing endpoint', () => {
  const invalid = report(['e', 'x', 'a', 't'], [edge('e', 'x'), edge('x', 'missing'), edge('a', 't'), ...distractors]);
  const result = run(invalid);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
