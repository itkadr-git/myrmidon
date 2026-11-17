import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const moduleOf = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const cases = [
  {
    a: { entry: 'a', modules: [moduleOf('a', 3, true)], edges: [edge('a', 'self', 'eager', 'a'), edge('a', 'missing', 'eager', null)] },
    b: { entry: 'z', modules: [moduleOf('z', 11, true)], edges: [edge('z', 'lost', 'lazy', null)] },
    expectedA: 'digraph imports {\n  n0 [label="a", style=solid];\n  n0 -> n0 [label="self", style=solid];\n  // unresolved: 1\n}\n',
    expectedB: 'digraph imports {\n  n0 [label="z", style=solid];\n  // unresolved: 1\n}\n',
    expectedUnion: 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="z", style=dashed];\n  n0 -> n0 [label="self", style=solid];\n  // unresolved: 2\n}\n',
  },
  {
    a: { entry: 'm', modules: [moduleOf('m', 21, true), moduleOf('z', 7, true)], edges: [edge('m', 'link', 'eager', 'z')] },
    b: { entry: 'a', modules: [moduleOf('a', 5, true), moduleOf('n', 13, false)], edges: [edge('a', 'later', 'lazy', 'n')] },
    expectedA: 'digraph imports {\n  n0 [label="m", style=solid];\n  n1 [label="z", style=solid];\n  n0 -> n1 [label="link", style=solid];\n  // unresolved: 0\n}\n',
    expectedB: 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="n", style=dashed];\n  n0 -> n1 [label="later", style=dashed];\n  // unresolved: 0\n}\n',
    expectedUnion: 'digraph imports {\n  n0 [label="a", style=dashed];\n  n1 [label="m", style=solid];\n  n2 [label="n", style=dashed];\n  n3 [label="z", style=solid];\n  n0 -> n2 [label="later", style=dashed];\n  n1 -> n3 [label="link", style=solid];\n  // unresolved: 0\n}\n',
  },
  {
    a: { entry: 'a"x', modules: [moduleOf('a"x', 2, true), moduleOf('c', 9, false)], edges: [edge('a"x', 'say"hi\\there', 'lazy', 'c')] },
    b: { entry: 'b', modules: [moduleOf('b', 17, true)], edges: [edge('b', 'loop', 'eager', 'b'), edge('b', 'unknown', 'eager', null)] },
    expectedA: 'digraph imports {\n  n0 [label="a\\"x", style=solid];\n  n1 [label="c", style=dashed];\n  n0 -> n1 [label="say\\"hi\\\\there", style=dashed];\n  // unresolved: 0\n}\n',
    expectedB: 'digraph imports {\n  n0 [label="b", style=solid];\n  n0 -> n0 [label="loop", style=solid];\n  // unresolved: 1\n}\n',
    expectedUnion: 'digraph imports {\n  n0 [label="a\\"x", style=solid];\n  n1 [label="b", style=dashed];\n  n2 [label="c", style=dashed];\n  n0 -> n2 [label="say\\"hi\\\\there", style=dashed];\n  n1 -> n1 [label="loop", style=solid];\n  // unresolved: 1\n}\n',
  },
];

function check(report, expected) {
  const original = JSON.stringify(report);
  for (const candidate of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(candidate), encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
    }
  }
  assert.equal(JSON.stringify(report), original);
}

for (const [index, { a, b, expectedA, expectedB, expectedUnion }] of cases.entries()) {
  test(`disjoint composition ${index + 1}`, () => {
    const before = JSON.stringify([a, b]);
    check(a, expectedA);
    check(b, expectedB);
    const union = { entry: a.entry, modules: [...a.modules, ...b.modules.map(m => ({ ...m, eager: false }))], edges: [...a.edges, ...b.edges] };
    check(union, expectedUnion);
    assert.equal(JSON.stringify([a, b]), before);
  });
}

test('missing endpoint fails with sanitized graph category', () => {
  const input = JSON.stringify({ entry: 'a', modules: [moduleOf('a', 1, true)], edges: [edge('a', 'missing', 'eager', 'absent')] });
  const result = spawnSync(process.execPath, [cli], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
