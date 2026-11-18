import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const expected = 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n2 [label="c", style=dashed];\n  n3 [label="z", style=dashed];\n  n0 -> n2 [label="load", style=dashed];\n  n0 -> n1 [label="one", style=solid];\n  n1 -> n0 [label="back", style=solid];\n  // unresolved: 1\n}\n';
const fixture = () => ({
  entry: 'a',
  modules: [
    { path: 'a', bytes: 0, eager: true }, { path: 'b', bytes: 0, eager: true },
    { path: 'c', bytes: 0, eager: false }, { path: 'z', bytes: 0, eager: false },
  ],
  edges: [
    { from: 'a', specifier: 'one', kind: 'eager', to: 'b' },
    { from: 'a', specifier: 'load', kind: 'lazy', to: 'c' },
    { from: 'b', specifier: 'back', kind: 'eager', to: 'a' },
    { from: 'a', specifier: 'missing', kind: 'eager', to: null },
  ],
});
const annotations = { label: null, style: false, id: 17, counts: 'shadow', metadata: [1, null, { nested: true }], extra: { nested: ['value', { flag: false }] } };
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
const success = (report, oracle = expected) => {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, oracle);
};
const annotate = (report, levels) => ({
  ...(levels.includes('report') ? annotations : {}), ...report,
  modules: report.modules.map(m => levels.includes('modules') ? { ...annotations, ...m } : m),
  edges: report.edges.map(e => levels.includes('edges') ? { ...annotations, ...e } : e),
});
const reorder = value => {
  if (Array.isArray(value)) return value.map(reorder).reverse();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
  return value;
};

test('unknown annotations are isolated at every level and under permutations', () => {
  const base = fixture();
  const all = annotate(base, ['report', 'modules', 'edges']);
  success(base);
  for (const level of ['report', 'modules', 'edges']) success(annotate(base, [level]));
  success(all);
  success(reorder(all));
  success(base);
  success(all);
  success(base);
});

test('real edge fields remain meaningful and invalid graphs fail closed', () => {
  const changed = fixture();
  changed.edges[0].specifier = 'changed';
  const changedExpected = 'digraph imports {\n  n0 [label="a", style=solid];\n  n1 [label="b", style=solid];\n  n2 [label="c", style=dashed];\n  n3 [label="z", style=dashed];\n  n0 -> n1 [label="changed", style=solid];\n  n0 -> n2 [label="load", style=dashed];\n  n1 -> n0 [label="back", style=solid];\n  // unresolved: 1\n}\n';
  success(annotate(changed, ['report', 'modules', 'edges']), changedExpected);
  const invalidShape = fixture();
  invalidShape.edges[0].specifier = 'one\u0000';
  const invalidGraph = fixture();
  invalidGraph.edges[0].to = 'absent';
  for (const [report, category] of [[invalidShape, 'shape'], [invalidGraph, 'graph']]) {
    const result = run(annotate(report, ['report', 'modules', 'edges']));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  }
});
