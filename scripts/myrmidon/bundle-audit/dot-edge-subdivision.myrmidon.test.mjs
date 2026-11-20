import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const mod = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  }
  assert.equal(JSON.stringify(report), original);
}

test('subdividing an eager edge preserves other edges and canonical order', () => {
  const baseline = { entry: 'a', modules: [mod('c'), mod('a'), mod('b')], edges: [edge('b', './c', 'eager', 'c'), edge('a', './b', 'eager', 'b')] };
  const transformed = { entry: 'a', modules: [mod('c'), mod('a'), mod('b'), mod('x')], edges: [edge('b', './c', 'eager', 'c'), edge('a', './x', 'eager', 'x'), edge('x', './b-via-x', 'eager', 'b')] };
  check(baseline, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n2 [label="c", style=solid];\n  n0 -> n1 [label="./b", style=solid];\n  n1 -> n2 [label="./c", style=solid];\n  // unresolved: 0\n}\n');
  check(transformed, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n2 [label="c", style=solid];\n  n3 [label="x", style=solid];\n  n0 -> n3 [label="./x", style=solid];\n  n1 -> n2 [label="./c", style=solid];\n  n3 -> n1 [label="./b-via-x", style=solid];\n  // unresolved: 0\n}\n');
});

test('lazy first segment escapes intermediate path and specifiers', () => {
  const x = 'm"\\\n';
  const baseline = { entry: 'a', modules: [mod('z', false), mod('a')], edges: [edge('a', './z', 'lazy', 'z')] };
  const transformed = { entry: 'a', modules: [mod('z', false), mod(x, false), mod('a')], edges: [edge(x, './z-via-m', 'eager', 'z'), edge('a', './m"\\\n', 'lazy', x)] };
  check(baseline, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="z", style=dashed];\n  n0 -> n1 [label="./z", style=dashed];\n  // unresolved: 0\n}\n');
  check(transformed, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="m\\"\\\\\\n", style=dashed];\n  n2 [label="z", style=dashed];\n  n0 -> n1 [label="./m\\"\\\\\\n", style=dashed];\n  n1 -> n2 [label="./z-via-m", style=solid];\n  // unresolved: 0\n}\n');
});

test('subdivision preserves unresolved edges and a parallel route', () => {
  const baseline = { entry: 'a', modules: [mod('a'), mod('b')], edges: [edge('a', 'direct', 'eager', 'b'), edge('a', 'other', 'eager', 'b'), edge('b', 'external', 'eager', null)] };
  const transformed = { entry: 'a', modules: [mod('a'), mod('b'), mod('aa')], edges: [edge('a', 'first', 'eager', 'aa'), edge('aa', 'second', 'eager', 'b'), edge('a', 'other', 'eager', 'b'), edge('b', 'external', 'eager', null)] };
  check(baseline, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n0 -> n1 [label="direct", style=solid];\n  n0 -> n1 [label="other", style=solid];\n  // unresolved: 1\n}\n');
  check(transformed, 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="aa", style=solid];\n  n2 [label="b", style=solid];\n  n0 -> n1 [label="first", style=solid];\n  n0 -> n2 [label="other", style=solid];\n  n1 -> n2 [label="second", style=solid];\n  // unresolved: 1\n}\n');
});

test('rejects a subdivision whose intermediate endpoint is missing', () => {
  const report = { entry: 'a', modules: [mod('a'), mod('b')], edges: [edge('a', './x', 'eager', 'x'), edge('x', './b', 'eager', 'b')] };
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
