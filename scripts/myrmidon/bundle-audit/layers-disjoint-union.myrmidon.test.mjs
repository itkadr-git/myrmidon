import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
const mod = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });

const cases = [
  {
    a: { entry: 'a0', modules: [mod('a0', 1), mod('a1', 2)], edges: [edge('a0', 'a1')] },
    b: { entry: 'b0', modules: [mod('b0', 3), mod('b1', 4), mod('b2', 5)], edges: [edge('b0', 'b1'), edge('b1', 'b2'), edge('b2', 'b0'), edge('b0', 'b2', 'lazy')] },
    aExpected: { entry: 'a0', layers: [{ depth: 0, paths: ['a0'], bytes: 1 }, { depth: 1, paths: ['a1'], bytes: 2 }], unreachable: [] },
    bExpected: { entry: 'b0', layers: [{ depth: 0, paths: ['b0'], bytes: 3 }, { depth: 1, paths: ['b1'], bytes: 4 }, { depth: 2, paths: ['b2'], bytes: 5 }], unreachable: [] },
    abExpected: { entry: 'a0', layers: [{ depth: 0, paths: ['a0'], bytes: 1 }, { depth: 1, paths: ['a1'], bytes: 2 }], unreachable: ['b0', 'b1', 'b2'] },
    baExpected: { entry: 'b0', layers: [{ depth: 0, paths: ['b0'], bytes: 3 }, { depth: 1, paths: ['b1'], bytes: 4 }, { depth: 2, paths: ['b2'], bytes: 5 }], unreachable: ['a0', 'a1'] },
  },
  {
    a: { entry: 'c0', modules: [mod('c0', 0), mod('c1', 7), mod('c2', 8)], edges: [edge('c0', 'c1'), edge('c0', 'c2')] },
    b: { entry: 'd0', modules: [mod('d0', 2), mod('d1', 0), mod('d2', 6)], edges: [edge('d0', 'd1'), edge('d1', 'd2'), edge('d2', 'd0'), edge('d0', 'd2', 'lazy')] },
    aExpected: { entry: 'c0', layers: [{ depth: 0, paths: ['c0'], bytes: 0 }, { depth: 1, paths: ['c1', 'c2'], bytes: 15 }], unreachable: [] },
    bExpected: { entry: 'd0', layers: [{ depth: 0, paths: ['d0'], bytes: 2 }, { depth: 1, paths: ['d1'], bytes: 0 }, { depth: 2, paths: ['d2'], bytes: 6 }], unreachable: [] },
    abExpected: { entry: 'c0', layers: [{ depth: 0, paths: ['c0'], bytes: 0 }, { depth: 1, paths: ['c1', 'c2'], bytes: 15 }], unreachable: ['d0', 'd1', 'd2'] },
    baExpected: { entry: 'd0', layers: [{ depth: 0, paths: ['d0'], bytes: 2 }, { depth: 1, paths: ['d1'], bytes: 0 }, { depth: 2, paths: ['d2'], bytes: 6 }], unreachable: ['c0', 'c1', 'c2'] },
  },
  {
    a: { entry: 'z0', modules: [mod('z0', 9)], edges: [] },
    b: { entry: 'e0', modules: [mod('e0', 10), mod('e1', 11), mod('e2', 12), mod('e3', 13, false)], edges: [edge('e0', 'e1'), edge('e1', 'e2'), edge('e2', 'e0'), edge('e0', 'e2', 'lazy'), edge('e0', 'e3', 'lazy')] },
    aExpected: { entry: 'z0', layers: [{ depth: 0, paths: ['z0'], bytes: 9 }], unreachable: [] },
    bExpected: { entry: 'e0', layers: [{ depth: 0, paths: ['e0'], bytes: 10 }, { depth: 1, paths: ['e1'], bytes: 11 }, { depth: 2, paths: ['e2'], bytes: 12 }], unreachable: ['e3'] },
    abExpected: { entry: 'z0', layers: [{ depth: 0, paths: ['z0'], bytes: 9 }], unreachable: ['e0', 'e1', 'e2', 'e3'] },
    baExpected: { entry: 'e0', layers: [{ depth: 0, paths: ['e0'], bytes: 10 }, { depth: 1, paths: ['e1'], bytes: 11 }, { depth: 2, paths: ['e2'], bytes: 12 }], unreachable: ['e3', 'z0'] },
  },
];

function check(report, expected) {
  const before = JSON.stringify(report);
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
  assert.equal(JSON.stringify(report), before);
}

test('disjoint unions preserve each entry component and report every unreachable module', () => {
  const before = JSON.stringify(cases);
  for (const { a, b, aExpected, bExpected, abExpected, baExpected } of cases) {
    check(a, aExpected);
    check(b, bExpected);
    check({ entry: a.entry, modules: [...a.modules, ...b.modules.map(m => ({ ...m, eager: false }))], edges: [...a.edges, ...b.edges] }, abExpected);
    check({ entry: b.entry, modules: [...a.modules.map(m => ({ ...m, eager: false })), ...b.modules], edges: [...a.edges, ...b.edges] }, baExpected);
  }
  assert.equal(JSON.stringify(cases), before);
});

test('invalid eager flag and missing endpoint return sanitized graph errors', () => {
  const { a, b } = cases[0];
  const union = { entry: a.entry, modules: [...a.modules, ...b.modules.map(m => ({ ...m, eager: false }))], edges: [...a.edges, ...b.edges] };
  const invalid = [
    { ...union, modules: union.modules.map(m => m.path === 'b0' ? { ...m, eager: true } : m) },
    { ...union, edges: [...union.edges, edge('a0', 'secret-missing-endpoint')] },
  ];
  for (const report of invalid) {
    const result = run(report);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
