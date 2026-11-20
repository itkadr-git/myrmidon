import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const sentinel = 'extension-private-sentinel';
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 30000,
});
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const graphs = [
  {
    report: { entry: 'a', modules: [m('a', 2), m('b', 3), m('c', 5), m('d', 7)], edges: [e('a','b'), e('b','a'), e('c','d'), e('d','c'), e('a','c'), e('b','d'), e('d','a','lazy')] },
    eager: { entry: 'a', components: [{ id: 'a', paths: ['a','b'], bytes: 5 }, { id: 'c', paths: ['c','d'], bytes: 12 }], edges: [{ from: 'a', to: 'c' }] },
    all: { entry: 'a', components: [{ id: 'a', paths: ['a','b','c','d'], bytes: 17 }], edges: [] },
  },
  {
    report: { entry: 'p', modules: [m('p', 11), m('q', 13), m('r', 17, false)], edges: [e('p','q'), e('q','r','lazy'), e('r','q')] },
    eager: { entry: 'p', components: [{ id: 'p', paths: ['p'], bytes: 11 }, { id: 'q', paths: ['q'], bytes: 13 }, { id: 'r', paths: ['r'], bytes: 17 }], edges: [{ from: 'p', to: 'q' }, { from: 'r', to: 'q' }] },
    all: { entry: 'p', components: [{ id: 'p', paths: ['p'], bytes: 11 }, { id: 'q', paths: ['q','r'], bytes: 30 }], edges: [{ from: 'p', to: 'q' }] },
  },
];
const metadata = { path: sentinel, from: 'fake', to: 'fake', bytes: -1, eager: false, nested: [null, true, { value: sentinel }] };
function decorate(report, section) {
  const copy = structuredClone(report);
  if (section === 'report' || section === 'all') Object.assign(copy, { x_meta: metadata, x_note: null, x_weight: true });
  if (section === 'module' || section === 'all') copy.modules.forEach(module => Object.assign(module, { x_meta: metadata, x_note: [sentinel, false], x_weight: 'heavy' }));
  if (section === 'edge' || section === 'all') copy.edges.forEach(edge => Object.assign(edge, { x_meta: metadata, x_note: sentinel, x_weight: [null, true] }));
  return copy;
}

test('unknown producer fields do not affect full condensation output', () => {
  for (const graph of graphs) for (const mode of ['eager', 'all']) {
    for (const section of ['base', 'report', 'module', 'edge', 'all']) {
      const report = decorate(graph.report, section);
      for (const permuted of [false, true]) {
        const fixture = structuredClone(report);
        if (permuted) { fixture.modules.reverse(); fixture.edges.reverse(); }
        const before = JSON.stringify(fixture);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = run(fixture, mode);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, `${JSON.stringify(graph[mode])}\n`);
          assert.ok(!result.stdout.includes(sentinel));
          assert.equal(JSON.stringify(fixture), before);
        }
      }
    }
  }
});

test('extensions cannot mask invalid known fields or leak in errors', () => {
  for (const graph of graphs) for (const mode of ['eager', 'all']) {
    for (const category of ['shape', 'graph']) {
      const fixture = decorate(graph.report, 'all');
      if (category === 'shape') fixture.modules[0].bytes = -1;
      else fixture.edges[0].to = 'missing';
      const before = JSON.stringify(fixture);
      const result = run(fixture, mode);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${category}\n`);
      assert.ok(!result.stderr.includes(sentinel));
      assert.equal(JSON.stringify(fixture), before);
    }
  }
});
