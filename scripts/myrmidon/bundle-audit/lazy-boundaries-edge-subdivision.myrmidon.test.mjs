import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-lazy-boundaries.mjs', import.meta.url).pathname;
const mod = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
  assert.equal(JSON.stringify(report), original);
}

test('subdivision preserves a diamond closure without counting the shared node twice', () => {
  const baseline = {
    entry: 'entry',
    modules: [mod('entry', 1, true), mod('target', 7, false), mod('left', 2, false), mod('right', 5, false), mod('shared', 11, false)],
    edges: [edge('entry', './target', 'lazy', 'target'), edge('target', './left', 'eager', 'left'), edge('target', './right', 'eager', 'right'), edge('left', './shared', 'eager', 'shared'), edge('right', './shared', 'eager', 'shared')],
  };
  const transformed = {
    entry: 'entry',
    modules: [...baseline.modules, mod('intermediate', 3, false)],
    edges: [edge('entry', './intermediate', 'lazy', 'intermediate'), edge('intermediate', './target-via-intermediate', 'eager', 'target'), ...baseline.edges.slice(1)],
  };
  check(baseline, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './target', to: 'target', bytes: 25 }] });
  check(transformed, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './intermediate', to: 'intermediate', bytes: 28 }] });
});

test('subdivision excludes a target already reachable eagerly at startup', () => {
  const baseline = {
    entry: 'entry',
    modules: [mod('entry', 1, true), mod('target', 7, true), mod('leaf', 5, true)],
    edges: [edge('entry', './eager-target', 'eager', 'target'), edge('target', './leaf', 'eager', 'leaf'), edge('entry', './lazy-target', 'lazy', 'target')],
  };
  const transformed = {
    entry: 'entry',
    modules: [...baseline.modules, mod('intermediate', 3, false)],
    edges: [...baseline.edges.slice(0, 2), edge('entry', './lazy-intermediate', 'lazy', 'intermediate'), edge('intermediate', './target-via-intermediate', 'eager', 'target')],
  };
  check(baseline, { entry: 'entry', boundaries: [] });
  check(transformed, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './lazy-intermediate', to: 'intermediate', bytes: 3 }] });
});

test('subdivision preserves unrelated boundaries and excludes non-startup lazy sources', () => {
  const baseline = {
    entry: 'entry',
    modules: [mod('entry', 1, true), mod('startup', 2, true), mod('target', 7, false), mod('other', 13, false), mod('nested', 17, false)],
    edges: [edge('entry', './startup', 'eager', 'startup'), edge('startup', './target', 'lazy', 'target'), edge('entry', './other', 'lazy', 'other'), edge('target', './nested', 'lazy', 'nested')],
  };
  const transformed = {
    entry: 'entry',
    modules: [...baseline.modules, mod('intermediate', 3, false)],
    edges: [baseline.edges[0], edge('startup', './intermediate', 'lazy', 'intermediate'), edge('intermediate', './target-via-intermediate', 'eager', 'target'), ...baseline.edges.slice(2)],
  };
  check(baseline, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './other', to: 'other', bytes: 13 }, { from: 'startup', specifier: './target', to: 'target', bytes: 7 }] });
  check(transformed, { entry: 'entry', boundaries: [{ from: 'entry', specifier: './other', to: 'other', bytes: 13 }, { from: 'startup', specifier: './intermediate', to: 'intermediate', bytes: 10 }] });
});

test('subdivision rejects an endpoint absent from modules', () => {
  const report = { entry: 'entry', modules: [mod('entry', 1, true), mod('target', 7, false)], edges: [edge('entry', './intermediate', 'lazy', 'intermediate'), edge('intermediate', './target', 'eager', 'target')] };
  const result = spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
