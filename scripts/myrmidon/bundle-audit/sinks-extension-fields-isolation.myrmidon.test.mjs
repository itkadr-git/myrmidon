import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const sentinel = 'synthetic-extension-sentinel';
const annotation = {
  x_meta: { path: 'fake', from: 'fake', to: 'fake', bytes: -1, eager: false, nested: [null, true, sentinel] },
  x_note: [false, null, { path: sentinel }],
  x_weight: 'synthetic-extension-sentinel',
};
const moduleOf = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const fixtures = [
  {
    report: {
      entry: 'a',
      modules: [moduleOf('a', 1, true), moduleOf('b', 2, true), moduleOf('c', 3, true), moduleOf('d', 7, true), moduleOf('lazy', 40, false), moduleOf('z', 20, false)],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'lazy', 'lazy')],
    },
    expected: { entry: 'a', sinks: [{ path: 'd', bytes: 7 }], sinkBytes: 7 },
  },
  {
    report: {
      entry: 'root',
      modules: [moduleOf('root', 4, true), moduleOf('alpha', 5, true), moduleOf('beta', 9, true), moduleOf('later', 30, false), moduleOf('outside', 12, false)],
      edges: [edge('root', 'beta'), edge('root', 'alpha'), edge('beta', 'later', 'lazy')],
    },
    expected: { entry: 'root', sinks: [{ path: 'alpha', bytes: 5 }, { path: 'beta', bytes: 9 }], sinkBytes: 14 },
  },
];

function decorated(report, levels) {
  const copy = structuredClone(report);
  if (levels.includes('report')) Object.assign(copy, annotation);
  if (levels.includes('module')) copy.modules = copy.modules.map(mod => ({ ...mod, ...annotation }));
  if (levels.includes('edge')) copy.edges = copy.edges.map(item => ({ ...item, ...annotation }));
  return copy;
}

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
}

function success(report, expected) {
  const before = JSON.stringify(report);
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.ok(!result.stdout.includes(sentinel));
  assert.equal(JSON.stringify(report), before);
}

test('extensions do not change complete sinks output for either graph', () => {
  for (const { report, expected } of fixtures) {
    for (const levels of [[], ['report'], ['module'], ['edge'], ['report', 'module', 'edge']]) {
      const input = decorated(report, levels);
      success(input, expected);
      success(input, expected);
      success({ ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }, expected);
    }
  }
});

test('extensions cannot hide invalid required fields or leak in errors', () => {
  for (const { report } of fixtures) {
    const invalidBytes = decorated(report, ['report', 'module', 'edge']);
    invalidBytes.modules[0].bytes = -1;
    const invalidEndpoint = decorated(report, ['report', 'module', 'edge']);
    invalidEndpoint.edges[0].to = 'missing-endpoint';
    for (const [input, category] of [[invalidBytes, 'shape'], [invalidEndpoint, 'graph']]) {
      const before = JSON.stringify(input);
      const result = run(input);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, category + '\n');
      assert.ok(!result.stderr.includes(sentinel));
      assert.ok(!result.stderr.includes('missing-endpoint'));
      assert.equal(JSON.stringify(input), before);
    }
  }
});
