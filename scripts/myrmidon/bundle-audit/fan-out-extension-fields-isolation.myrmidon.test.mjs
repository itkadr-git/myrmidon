import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const sentinel = 'synthetic-extension-sentinel';
const graphs = [
  {
    report: { entry: 'a', modules: [
      {path: 'a', bytes: 10, eager: true}, {path: 'b', bytes: 20, eager: true},
      {path: 'c', bytes: 30, eager: false},
    ], edges: [
      {from: 'a', specifier: 'b', kind: 'eager', to: 'b'},
      {from: 'a', specifier: 'alias', kind: 'eager', to: 'b'},
      {from: 'a', specifier: 'lazy', kind: 'lazy', to: 'c'},
      {from: 'b', specifier: 'self', kind: 'eager', to: 'b'},
      {from: 'b', specifier: 'unknown', kind: 'eager', to: null},
    ]},
    expected: {entry: 'a', modules: [
      {path: 'a', bytes: 10, targets: ['b'], fanOut: 1},
      {path: 'b', bytes: 20, targets: ['b'], fanOut: 1},
      {path: 'c', bytes: 30, targets: [], fanOut: 0},
    ]},
  },
  {
    report: {entry: 'root', modules: [
      {path: 'root', bytes: 0, eager: true}, {path: 'x', bytes: 4, eager: true},
      {path: 'y', bytes: 7, eager: true}, {path: 'z', bytes: 9, eager: false},
    ], edges: [
      {from: 'root', specifier: 'x', kind: 'eager', to: 'x'},
      {from: 'root', specifier: 'y', kind: 'eager', to: 'y'},
      {from: 'x', specifier: 'unknown', kind: 'lazy', to: null},
      {from: 'y', specifier: 'z', kind: 'lazy', to: 'z'},
    ]},
    expected: {entry: 'root', modules: [
      {path: 'root', bytes: 0, targets: ['x', 'y'], fanOut: 2},
      {path: 'x', bytes: 4, targets: [], fanOut: 0},
      {path: 'y', bytes: 7, targets: [], fanOut: 0},
      {path: 'z', bytes: 9, targets: [], fanOut: 0},
    ]},
  },
];

const extension = () => ({
  x_meta: {path: sentinel, from: 'fake', to: 'fake', bytes: -1, eager: false,
    nested: [null, true, {path: 'fake', from: 'fake', to: 'fake'}]},
  x_note: [sentinel, false, null],
  x_weight: {value: sentinel, weights: [1, null, true]},
  ...JSON.parse('{"__proto__":{"path":"fake","eager":false}}'),
});
const clone = value => JSON.parse(JSON.stringify(value));
function decorate(report, levels) {
  const result = clone(report);
  if (levels.includes('report')) Object.defineProperties(result, Object.getOwnPropertyDescriptors(extension()));
  if (levels.includes('modules')) result.modules = result.modules.map(mod => ({...mod, ...extension()}));
  if (levels.includes('edges')) result.edges = result.edges.map(edge => ({...edge, ...extension()}));
  return result;
}
function run(report) {
  return spawnSync(process.execPath, [cli], {input: JSON.stringify(report), encoding: 'utf8', cwd: homedir()});
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
function failure(report, category) {
  const before = JSON.stringify(report);
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, category + '\n');
  assert.ok(!result.stderr.includes(sentinel));
  assert.equal(JSON.stringify(report), before);
}

test('extension fields do not alter complete fan-out output or input', () => {
  for (const {report, expected} of graphs) {
    for (const levels of [[], ['report'], ['modules'], ['edges'], ['report', 'modules', 'edges']]) {
      const value = decorate(report, levels);
      success(value, expected);
      success(value, expected);
      value.modules.reverse();
      value.edges.reverse();
      success(value, expected);
    }
  }
});

test('decorations do not mask invalid bytes or unknown endpoints', () => {
  for (const {report} of graphs) {
    const invalidBytes = decorate(report, ['report', 'modules', 'edges']);
    invalidBytes.modules[0].bytes = -1;
    failure(invalidBytes, 'shape');
    const invalidEndpoint = decorate(report, ['report', 'modules', 'edges']);
    invalidEndpoint.edges[0].to = sentinel;
    failure(invalidEndpoint, 'graph');
  }
});
