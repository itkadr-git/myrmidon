import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const sentinel = 'synthetic-extension-sentinel';
const metadata = { path: 'wrong', from: 'wrong', to: 'wrong', bytes: -1, eager: false, dominators: ['wrong'], note: sentinel };
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${to}` });
const graphs = [
  {
    report: { entry: 'a', modules: ['a', 'b', 'c', 'd', 'e'].map(path => ({ path, bytes: 0, eager: true })), edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('d', 'e'), edge('a', 'e', 'lazy')] },
    target: 'e', expected: { entry: 'a', target: 'e', dominators: ['a', 'd', 'e'] },
  },
  {
    report: { entry: 'root', modules: [{ path: 'root', bytes: 2, eager: true }, { path: 'mid', bytes: 3, eager: true }, { path: 'leaf', bytes: 4, eager: true }, { path: 'lazy', bytes: 5, eager: false }], edges: [edge('root', 'mid'), edge('mid', 'leaf'), edge('root', 'lazy', 'lazy')] },
    target: 'leaf', expected: { entry: 'root', target: 'leaf', dominators: ['leaf', 'mid', 'root'] },
  },
];
const decorations = {
  report: { x_meta: metadata, x_note: [null, true, sentinel], x_weight: null },
  module: { x_meta: [metadata, false], x_note: sentinel, x_weight: { value: 42 } },
  edge: { x_meta: metadata, x_note: null, x_weight: [true, sentinel] },
};
function decorate(report, kinds) {
  return {
    ...report,
    ...(kinds.includes('report') ? decorations.report : {}),
    modules: report.modules.map(mod => ({ ...mod, ...(kinds.includes('module') ? decorations.module : {}) })),
    edges: report.edges.map(item => ({ ...item, ...(kinds.includes('edge') ? decorations.edge : {}) })),
  };
}
function run(input, target) {
  return spawnSync(process.execPath, [cli, '-', target], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
}

test('extension fields do not interfere with dominators', () => {
  for (const { report, target, expected } of graphs) {
    const original = JSON.stringify(report);
    const variants = [report, decorate(report, ['report']), decorate(report, ['module']), decorate(report, ['edge']), decorate(report, ['report', 'module', 'edge'])];
    const combined = variants[4];
    variants.push({ ...combined, modules: [...combined.modules].reverse(), edges: [...combined.edges].reverse() }, combined);
    for (const input of variants) {
      const before = JSON.stringify(input);
      const result = run(input, target);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(expected) + '\n');
      assert.ok(!result.stdout.includes(sentinel));
      assert.equal(JSON.stringify(input), before);
    }
    assert.equal(JSON.stringify(report), original);
  }
});

test('decorations do not conceal invalid required fields or leak into errors', () => {
  const input = decorate(graphs[0].report, ['report', 'module', 'edge']);
  const cases = [
    [{ ...input, modules: input.modules.map((mod, i) => i === 0 ? { ...mod, bytes: -1 } : mod) }, 'shape\n'],
    [{ ...input, edges: [...input.edges, edge('a', sentinel)] }, 'graph\n'],
  ];
  for (const [invalid, category] of cases) {
    const before = JSON.stringify(invalid);
    const result = run(invalid, 'e');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, category);
    assert.ok(!result.stderr.includes(sentinel));
    assert.equal(JSON.stringify(invalid), before);
  }
});
