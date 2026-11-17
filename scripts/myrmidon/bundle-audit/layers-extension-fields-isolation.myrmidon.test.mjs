import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const sentinel = 'synthetic-extension-sentinel';
const annotation = { depth: 987, path: 'false-path', from: 'false-from', to: 'false-to', bytes: -999, eager: false, payload: [null, true, sentinel] };
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
const clone = value => JSON.parse(JSON.stringify(value));

const graphs = [
  {
    report: { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3), moduleOf('c', 4), moduleOf('z', 5, false)], edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 'c'), edge('b', 'c'), edge('e', 'c', 'lazy')] },
    expected: { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'b'], bytes: 5 }, { depth: 2, paths: ['c'], bytes: 4 }], unreachable: ['z'] },
  },
  {
    report: { entry: 'root', modules: [moduleOf('root', 10), moduleOf('leaf', 7), moduleOf('off', 2, false)], edges: [edge('root', 'leaf'), edge('leaf', 'root'), edge('root', 'off', 'lazy')] },
    expected: { entry: 'root', layers: [{ depth: 0, paths: ['root'], bytes: 10 }, { depth: 1, paths: ['leaf'], bytes: 7 }], unreachable: ['off'] },
  },
];

function decorate(report, where) {
  const result = clone(report);
  if (where.includes('report')) result.x_meta = { ...annotation, x_note: null };
  if (where.includes('module')) for (const mod of result.modules) { mod.x_note = [false, annotation, null]; mod.x_weight = 'ignored'; }
  if (where.includes('edge')) for (const item of result.edges) { item.x_weight = { ...annotation }; item.x_note = sentinel; }
  return result;
}

test('extension fields cannot affect exact eager layers or escape into output', () => {
  for (const { report, expected } of graphs) {
    const original = JSON.stringify(report);
    for (const where of [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']]) {
      const decorated = decorate(report, where);
      const before = JSON.stringify(decorated);
      for (const candidate of [decorated, { ...decorated, modules: [...decorated.modules].reverse(), edges: [...decorated.edges].reverse() }]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = run(candidate);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
          assert.ok(!result.stdout.includes(sentinel));
        }
      }
      assert.equal(JSON.stringify(decorated), before);
    }
    assert.equal(JSON.stringify(report), original);
  }
});

test('extensions do not mask invalid known fields or leak error payloads', () => {
  for (const { report } of graphs) {
    for (const category of ['shape', 'graph']) {
      const decorated = decorate(report, ['report', 'module', 'edge']);
      if (category === 'shape') decorated.modules[0].bytes = -1;
      else decorated.edges[0].to = 'missing-endpoint';
      const before = JSON.stringify(decorated);
      const result = run(decorated);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${category}\n`);
      assert.ok(!result.stderr.includes(sentinel));
      assert.ok(!result.stderr.includes('missing-endpoint'));
      assert.equal(JSON.stringify(decorated), before);
    }
  }
});
