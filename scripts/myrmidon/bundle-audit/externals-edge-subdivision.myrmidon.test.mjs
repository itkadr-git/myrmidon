import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const mod = (path, eager = true) => ({ path, bytes: 0, eager });
const edge = (from, specifier, kind, to = null) => ({ from, specifier, kind, to });
const run = report => spawnSync(process.execPath, [cli, '-'], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(JSON.stringify(report), original);
  }
}

test('subdivision preserves inventories for eager and lazy local edges', () => {
  const baseline = { entry: 'entry', modules: [mod('entry'), mod('v'), mod('lazy', false)], edges: [
    edge('entry', './v', 'eager', 'v'), edge('v', './lazy', 'lazy', 'lazy'),
    edge('v', 'pkg', 'eager'), edge('lazy', 'pkg/sub', 'lazy'), edge('v', './missing', 'eager'),
  ] };
  const transformed = { entry: 'entry', modules: [mod('entry'), mod('v'), mod('lazy', false), mod('wrapper')], edges: [
    edge('entry', './wrapper', 'eager', 'wrapper'), edge('wrapper', './v', 'eager', 'v'), edge('v', './lazy', 'lazy', 'lazy'),
    edge('v', 'pkg', 'eager'), edge('lazy', 'pkg/sub', 'lazy'), edge('v', './missing', 'eager'),
  ] };
  check(baseline, { entry: 'entry', externals: [
    { specifier: 'pkg', eagerImporters: ['v'], lazyImporters: [] },
    { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['lazy'] },
  ], unresolvedLocal: [{ specifier: './missing', eagerImporters: ['v'], lazyImporters: [] }] });
  check(transformed, { entry: 'entry', externals: [
    { specifier: 'pkg', eagerImporters: ['v'], lazyImporters: [] },
    { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['lazy'] },
  ], unresolvedLocal: [{ specifier: './missing', eagerImporters: ['v'], lazyImporters: [] }] });
});

test('moving an unresolved dependency to a lazy wrapper replaces its importer', () => {
  const baseline = { entry: 'entry', modules: [mod('entry'), mod('v', false)], edges: [
    edge('entry', './v', 'lazy', 'v'), edge('v', 'moved', 'lazy'), edge('entry', 'stable', 'eager'), edge('v', '../missing', 'lazy'),
  ] };
  const transformed = { entry: 'entry', modules: [mod('entry'), mod('v', false), mod('wrapper', false)], edges: [
    edge('entry', './wrapper', 'lazy', 'wrapper'), edge('wrapper', './v', 'eager', 'v'), edge('wrapper', 'moved', 'lazy'), edge('entry', 'stable', 'eager'), edge('v', '../missing', 'lazy'),
  ] };
  check(baseline, { entry: 'entry', externals: [
    { specifier: 'moved', eagerImporters: [], lazyImporters: ['v'] },
    { specifier: 'stable', eagerImporters: ['entry'], lazyImporters: [] },
  ], unresolvedLocal: [{ specifier: '../missing', eagerImporters: [], lazyImporters: ['v'] }] });
  check(transformed, { entry: 'entry', externals: [
    { specifier: 'moved', eagerImporters: [], lazyImporters: ['wrapper'] },
    { specifier: 'stable', eagerImporters: ['entry'], lazyImporters: [] },
  ], unresolvedLocal: [{ specifier: '../missing', eagerImporters: [], lazyImporters: ['v'] }] });
});

test('shared specifier retains both wrapper and original importer in their respective kinds', () => {
  const baseline = { entry: 'entry', modules: [mod('entry'), mod('v')], edges: [
    edge('entry', './v', 'eager', 'v'), edge('v', 'shared', 'eager'), edge('entry', 'shared', 'lazy'), edge('v', './missing', 'lazy'),
  ] };
  const transformed = { entry: 'entry', modules: [mod('entry'), mod('v'), mod('wrapper')], edges: [
    edge('entry', './wrapper', 'eager', 'wrapper'), edge('wrapper', './v', 'eager', 'v'), edge('v', 'shared', 'eager'), edge('entry', 'shared', 'lazy'), edge('wrapper', 'shared', 'lazy'), edge('v', './missing', 'lazy'),
  ] };
  check(baseline, { entry: 'entry', externals: [
    { specifier: 'shared', eagerImporters: ['v'], lazyImporters: ['entry'] },
  ], unresolvedLocal: [{ specifier: './missing', eagerImporters: [], lazyImporters: ['v'] }] });
  check(transformed, { entry: 'entry', externals: [
    { specifier: 'shared', eagerImporters: ['v'], lazyImporters: ['entry', 'wrapper'] },
  ], unresolvedLocal: [{ specifier: './missing', eagerImporters: [], lazyImporters: ['v'] }] });
});

test('rejects a subdivision whose new endpoint is missing', () => {
  const result = run({ entry: 'entry', modules: [mod('entry'), mod('v')], edges: [
    edge('entry', './wrapper', 'eager', 'wrapper'), edge('wrapper', './v', 'eager', 'v'),
  ] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
