import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const sentinel = 'synthetic-extension-sentinel';
const fixtures = [
  {
    report: { entry: 'a', modules: [
      { path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: 3, eager: true },
      { path: 'c', bytes: 5, eager: false }, { path: 'd', bytes: 7, eager: false },
    ], edges: [
      { from: 'a', specifier: 'b', kind: 'eager', to: 'b' },
      { from: 'b', specifier: 'c', kind: 'lazy', to: 'c' },
      { from: 'c', specifier: 'd', kind: 'eager', to: 'd' },
    ] },
    eager: { entry: 'a', components: [
      { id: 'a', paths: ['a', 'b'], bytes: 5 }, { id: 'c', paths: ['c', 'd'], bytes: 12 },
    ] },
    all: { entry: 'a', components: [{ id: 'a', paths: ['a', 'b', 'c', 'd'], bytes: 17 }] },
  },
  {
    report: { entry: 'z', modules: [
      { path: 'z', bytes: 11, eager: true }, { path: 'A', bytes: 0, eager: false },
      { path: 'm', bytes: 4, eager: false }, { path: 'n', bytes: 6, eager: false },
    ], edges: [
      { from: 'n', specifier: 'm', kind: 'eager', to: 'm' },
      { from: 'z', specifier: 'external', kind: 'lazy', to: null },
    ] },
    eager: { entry: 'z', components: [
      { id: 'A', paths: ['A'], bytes: 0 }, { id: 'm', paths: ['m', 'n'], bytes: 10 },
      { id: 'z', paths: ['z'], bytes: 11 },
    ] },
    all: { entry: 'z', components: [
      { id: 'A', paths: ['A'], bytes: 0 }, { id: 'm', paths: ['m', 'n'], bytes: 10 },
      { id: 'z', paths: ['z'], bytes: 11 },
    ] },
  },
];

function decorate(report, level) {
  const copy = structuredClone(report);
  const annotation = { path: 'fake', from: 'fake', to: 'fake', bytes: -1, eager: false, nested: [null, true, sentinel] };
  if (level === 'report' || level === 'all') {
    copy.x_meta = annotation;
    copy.x_note = null;
    copy.x_weight = [false, sentinel];
  }
  if (level === 'module' || level === 'all') {
    copy.modules.forEach((mod, index) => {
      mod.componentId = index % 2 ? 'same' : 'other';
      mod.x_meta = annotation;
      mod.x_note = sentinel;
      mod.x_weight = [null, true, { bytes: 999 }];
    });
  }
  if (level === 'edge' || level === 'all') {
    copy.edges.forEach(edge => {
      edge.x_meta = annotation;
      edge.x_note = [false, sentinel];
      edge.x_weight = { from: 'fake', to: 'fake', eager: true };
    });
  }
  return copy;
}

function run(report, mode) {
  return spawnSync(process.execPath, [cli, mode], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
  });
}

function success(report, mode, expected) {
  const before = JSON.stringify(report);
  const result = run(report, mode);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(JSON.stringify(report), before);
}

test('extension fields do not affect weak components in either mode', () => {
  for (const fixture of fixtures) {
    const original = JSON.stringify(fixture.report);
    for (const level of ['base', 'report', 'module', 'edge', 'all']) {
      const input = decorate(fixture.report, level);
      for (const mode of ['eager', 'all']) {
        success(input, mode, fixture[mode]);
        success(input, mode, fixture[mode]);
        success({ ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }, mode, fixture[mode]);
      }
    }
    assert.equal(JSON.stringify(fixture.report), original);
  }
});

test('extensions do not hide invalid fields or leak error payloads', () => {
  for (const fixture of fixtures) {
    for (const mode of ['eager', 'all']) {
      for (const category of ['shape', 'graph']) {
        const input = decorate(fixture.report, 'all');
        if (category === 'shape') input.modules[0].bytes = -1;
        else input.edges[0].to = 'missing-endpoint';
        const before = JSON.stringify(input);
        const result = run(input, mode);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, category + '\n');
        assert.equal(result.stderr.includes(sentinel), false);
        assert.equal(result.stderr.includes('missing-endpoint'), false);
        assert.equal(JSON.stringify(input), before);
      }
    }
  }
});
