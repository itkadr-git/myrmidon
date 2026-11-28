import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});

function expectSuccess(report, expected) {
  const result = run(report);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

function exercise(report, expected) {
  const original = JSON.stringify(report);
  expectSuccess(report, expected);
  expectSuccess(report, expected);
  expectSuccess({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, expected);
  assert.equal(JSON.stringify(report), original);
}

test('subdividing a winning eager edge with a zero-byte module keeps the cost', () => {
  const baseline = {
    entry: 'app',
    modules: [moduleOf('app', 2), moduleOf('core', 5), moduleOf('end', 7), moduleOf('other', 3), moduleOf('lazy', 100, false)],
    edges: [edge('app', 'core', './core'), edge('core', 'end', './end'), edge('app', 'other', './other'), edge('app', 'lazy', './lazy', 'lazy'), edge('core', null, 'external')],
  };
  const transformed = {
    ...baseline,
    modules: [...baseline.modules, moduleOf('middle', 0)],
    edges: [baseline.edges[0], edge('core', 'middle', './middle'), edge('middle', 'end', './end'), ...baseline.edges.slice(2)],
  };
  exercise(baseline, { entry: 'app', paths: ['app', 'core', 'end'], bytes: 14 });
  exercise(transformed, { entry: 'app', paths: ['app', 'core', 'middle', 'end'], bytes: 14 });
});

test('subdividing a losing eager branch leaves the unique maximum unchanged', () => {
  const baseline = {
    entry: 'root',
    modules: [moduleOf('root', 1), moduleOf('winner', 9), moduleOf('branch', 2), moduleOf('leaf', 3), moduleOf('lazy', 80, false)],
    edges: [edge('root', 'winner', './winner'), edge('root', 'branch', './branch'), edge('branch', 'leaf', './leaf'), edge('root', 'lazy', './lazy', 'lazy'), edge('branch', null, 'external')],
  };
  const transformed = {
    ...baseline,
    modules: [...baseline.modules, moduleOf('middle', 0)],
    edges: [baseline.edges[0], baseline.edges[1], edge('branch', 'middle', './middle'), edge('middle', 'leaf', './leaf'), ...baseline.edges.slice(3)],
  };
  exercise(baseline, { entry: 'root', paths: ['root', 'winner'], bytes: 10 });
  exercise(transformed, { entry: 'root', paths: ['root', 'winner'], bytes: 10 });
});

test('adding weight to the inserted module makes the losing branch win', () => {
  const baseline = {
    entry: 'start',
    modules: [moduleOf('start', 3), moduleOf('fast', 8), moduleOf('slow', 2), moduleOf('finish', 4), moduleOf('lazy', 99, false)],
    edges: [edge('start', 'fast', './fast'), edge('start', 'slow', './slow'), edge('slow', 'finish', './finish'), edge('start', 'lazy', './lazy', 'lazy'), edge('slow', null, 'external')],
  };
  const zero = {
    ...baseline,
    modules: [...baseline.modules, moduleOf('middle', 0)],
    edges: [baseline.edges[0], baseline.edges[1], edge('slow', 'middle', './middle'), edge('middle', 'finish', './finish'), ...baseline.edges.slice(3)],
  };
  const weighted = { ...zero, modules: [...baseline.modules, moduleOf('middle', 5)] };
  exercise(baseline, { entry: 'start', paths: ['start', 'fast'], bytes: 11 });
  exercise(zero, { entry: 'start', paths: ['start', 'fast'], bytes: 11 });
  exercise(weighted, { entry: 'start', paths: ['start', 'slow', 'middle', 'finish'], bytes: 14 });
});

test('a subdivided graph with a missing endpoint is rejected', () => {
  const report = {
    entry: 'a', modules: [moduleOf('a', 1), moduleOf('middle', 0)],
    edges: [edge('a', 'middle', './middle'), edge('middle', 'missing', './missing')],
  };
  const result = run(report);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
