import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleOf = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, specifier, kind, to });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });

function success(report, expected) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  }
}

function graphFailure(report) {
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
}

test('shortcut reduces depth without reducing the weighted critical path', () => {
  const base = { entry: 'entry', modules: [moduleOf('entry', 2), moduleOf('a', 3), moduleOf('b', 5), moduleOf('t', 7)], edges: [edge('entry', 'a'), edge('a', 'b'), edge('b', 't')] };
  const expected = { entry: 'entry', paths: ['entry', 'a', 'b', 't'], bytes: 17 };
  success(base, expected);
  success({ ...base, edges: [...base.edges, edge('entry', 't', 'eager', 'shortcut')] }, expected);
});

test('eager addition raises the maximum, lazy addition does not, and removal restores it', () => {
  const base = { entry: 'entry', modules: [moduleOf('entry', 2), moduleOf('a', 3), moduleOf('b', 11), moduleOf('t', 13), moduleOf('u', 1)], edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 't'), edge('b', 'u')] };
  const original = { entry: 'entry', paths: ['entry', 'a', 't'], bytes: 18 };
  const eager = { ...base, edges: [...base.edges, edge('b', 't', 'eager', 'new-import')] };
  success(base, original);
  success(eager, { entry: 'entry', paths: ['entry', 'b', 't'], bytes: 26 });
  success({ ...base, edges: [...base.edges, edge('b', 't', 'lazy', 'new-import')] }, original);
  success({ ...eager, edges: eager.edges.filter(item => item.specifier !== 'new-import') }, original);
});

test('back edge is rejected only when eager', () => {
  const base = { entry: 'entry', modules: [moduleOf('entry', 2), moduleOf('a', 3), moduleOf('t', 7)], edges: [edge('entry', 'a'), edge('a', 't')] };
  const expected = { entry: 'entry', paths: ['entry', 'a', 't'], bytes: 12 };
  success(base, expected);
  success({ ...base, edges: [...base.edges, edge('t', 'entry', 'lazy', 'back')] }, expected);
  graphFailure({ ...base, edges: [...base.edges, edge('t', 'entry', 'eager', 'back')] });
});

test('missing endpoint fails as a sanitized graph error', () => {
  const report = { entry: 'entry', modules: [moduleOf('entry', 2)], edges: [edge('entry', 'SYNTHETIC_SECRET_SENTINEL')] };
  graphFailure(report);
});
