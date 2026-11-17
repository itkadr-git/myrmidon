import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const sentinel = 'synthetic-extension-sentinel';
const moduleRecord = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const graphs = [
  {
    report: { entry: 'a', modules: [moduleRecord('a', 1), moduleRecord('b', 4), moduleRecord('c', 4), moduleRecord('d', 2), moduleRecord('x', 100, false)], edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'x', 'lazy')] },
    expected: { entry: 'a', paths: ['a', 'b', 'd'], bytes: 7 },
  },
  {
    report: { entry: 'root', modules: [moduleRecord('root', 3), moduleRecord('left', 1), moduleRecord('right', 8), moduleRecord('leaf', 2)], edges: [edge('root', 'left'), edge('root', 'right'), edge('left', 'leaf')] },
    expected: { entry: 'root', paths: ['root', 'right'], bytes: 11 },
  },
];
const extensions = () => ({ x_meta: { path: 'false-path', from: 'false-from', to: 'false-to', bytes: -1, eager: false, cost: 9999, weight: 9999, note: sentinel }, x_note: [null, true, false, { nested: sentinel }], x_weight: '9999' });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });

function decorate(report, levels) {
  const result = structuredClone(report);
  if (levels.includes('report')) Object.assign(result, extensions());
  if (levels.includes('module')) result.modules = result.modules.map(mod => ({ ...mod, ...extensions() }));
  if (levels.includes('edge')) result.edges = result.edges.map(item => ({ ...item, ...extensions() }));
  return result;
}

function success(report, expected) {
  const before = structuredClone(report);
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.ok(!result.stdout.includes(sentinel));
  assert.deepEqual(report, before);
}

test('extension fields cannot change complete critical paths or weights', () => {
  for (const { report, expected } of graphs) {
    for (const levels of [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']]) {
      const decorated = decorate(report, levels);
      success(decorated, expected);
      success(decorated, expected);
      success({ ...decorated, modules: [...decorated.modules].reverse(), edges: [...decorated.edges].reverse() }, expected);
    }
  }
});

test('extensions do not hide invalid fields or leak payloads in errors', () => {
  for (const { report } of graphs) {
    for (const category of ['shape', 'graph']) {
      const decorated = decorate(report, ['report', 'module', 'edge']);
      if (category === 'shape') decorated.modules[0].bytes = -1;
      else decorated.edges[0].to = 'missing-endpoint-payload';
      const before = structuredClone(decorated);
      const result = run(decorated);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, category + '\n');
      assert.ok(!result.stderr.includes(sentinel));
      assert.ok(!result.stderr.includes('missing-endpoint-payload'));
      assert.deepEqual(decorated, before);
    }
  }
});
