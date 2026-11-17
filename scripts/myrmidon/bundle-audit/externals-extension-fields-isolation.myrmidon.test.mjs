import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const extensions = { x_meta: { path: sentinel, from: sentinel, to: sentinel, bytes: -1, eager: false, nested: [null, true, { x: sentinel }] }, x_note: sentinel, x_weight: [null, false, 'text'] };
const graphs = [
  {
    report: { entry: 'entry', modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'Z', bytes: 2, eager: true }, { path: 'a', bytes: 3, eager: false }], edges: [
      { from: 'entry', specifier: './Z', kind: 'eager', to: 'Z' },
      { from: 'entry', specifier: './a', kind: 'lazy', to: 'a' },
      { from: 'Z', specifier: 'pkg', kind: 'eager', to: null },
      { from: 'a', specifier: 'pkg', kind: 'lazy', to: null },
      { from: 'entry', specifier: 'Zoo', kind: 'eager', to: null },
      { from: 'entry', specifier: './missing', kind: 'lazy', to: null },
    ] },
    expected: { entry: 'entry', externals: [{ specifier: 'Zoo', eagerImporters: ['entry'], lazyImporters: [] }, { specifier: 'pkg', eagerImporters: ['Z'], lazyImporters: ['a'] }], unresolvedLocal: [{ specifier: './missing', eagerImporters: [], lazyImporters: ['entry'] }] },
  },
  {
    report: { entry: 'main', modules: [{ path: 'main', bytes: 0, eager: true }, { path: 'B', bytes: 4, eager: true }, { path: 'b', bytes: 5, eager: false }], edges: [
      { from: 'main', specifier: './B', kind: 'eager', to: 'B' },
      { from: 'B', specifier: './b', kind: 'lazy', to: 'b' },
      { from: 'main', specifier: 'same', kind: 'eager', to: null },
      { from: 'B', specifier: 'same', kind: 'eager', to: null },
      { from: 'b', specifier: 'same', kind: 'lazy', to: null },
      { from: 'B', specifier: '../lost', kind: 'eager', to: null },
      { from: 'b', specifier: './lost', kind: 'lazy', to: null },
    ] },
    expected: { entry: 'main', externals: [{ specifier: 'same', eagerImporters: ['B', 'main'], lazyImporters: ['b'] }], unresolvedLocal: [{ specifier: '../lost', eagerImporters: ['B'], lazyImporters: [] }, { specifier: './lost', eagerImporters: [], lazyImporters: ['b'] }] },
  },
];

function decorate(base, scope) {
  const report = structuredClone(base);
  if (scope === 'report' || scope === 'all') Object.assign(report, extensions);
  if (scope === 'module' || scope === 'all') report.modules.forEach(module => Object.assign(module, extensions));
  if (scope === 'edge' || scope === 'all') report.edges.forEach(edge => Object.assign(edge, extensions));
  return report;
}
function run(report) {
  return spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}

test('unknown extension fields do not affect complete inventories', () => {
  for (const { report, expected } of graphs) {
    for (const scope of ['base', 'report', 'module', 'edge', 'all']) {
      for (const reverse of [false, true]) {
        const fixture = decorate(report, scope);
        if (reverse) { fixture.modules.reverse(); fixture.edges.reverse(); }
        const before = JSON.stringify(fixture);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = run(fixture);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, JSON.stringify(expected) + '\n');
          assert.equal(result.stdout.includes(sentinel), false);
          assert.equal(JSON.stringify(fixture), before);
        }
      }
    }
  }
});

test('extensions cannot hide invalid known fields or leak into diagnostics', () => {
  for (const { report } of graphs) {
    for (const [mutate, category] of [
      [value => { value.modules[0].bytes = -1; }, 'shape'],
      [value => { value.edges[0].to = 'absent'; }, 'graph'],
    ]) {
      const fixture = decorate(report, 'all');
      mutate(fixture);
      const before = JSON.stringify(fixture), result = run(fixture);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, category + '\n');
      assert.equal(result.stderr.includes(sentinel), false);
      assert.equal(JSON.stringify(fixture), before);
    }
  }
});
