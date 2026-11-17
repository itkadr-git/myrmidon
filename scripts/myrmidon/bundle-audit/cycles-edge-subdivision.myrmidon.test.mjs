import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const moduleFor = (path, bytes = 1, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind, specifier) => ({ from, to, kind, specifier });

function invoke(report) {
  return spawnSync(process.execPath, [cli, '-'], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
  });
}

function check(report, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const input of [report, report, reversed]) {
    const result = invoke(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
  assert.equal(JSON.stringify(report), original);
}

test('subdividing an eager cycle includes the zero-byte module', () => {
  const baseline = { entry: 'a', modules: [moduleFor('a'), moduleFor('b')], edges: [
    edge('a', 'b', 'eager', './b'), edge('b', 'a', 'eager', './a'),
  ] };
  const transformed = { entry: 'a', modules: [moduleFor('a'), moduleFor('b'), moduleFor('x', 0)], edges: [
    edge('a', 'x', 'eager', './x'), edge('x', 'b', 'eager', './b-via-x'), edge('b', 'a', 'eager', './a'),
  ] };
  check(baseline, { entry: 'a', eagerCycles: [['a', 'b']], allCycles: [['a', 'b']] });
  check(transformed, { entry: 'a', eagerCycles: [['a', 'b', 'x']], allCycles: [['a', 'b', 'x']] });
});

test('subdividing a DAG edge does not create cycles', () => {
  const baseline = { entry: 'a', modules: [moduleFor('a'), moduleFor('b'), moduleFor('c')], edges: [
    edge('a', 'b', 'eager', './b'), edge('b', 'c', 'eager', './c'),
  ] };
  const transformed = { entry: 'a', modules: [moduleFor('a'), moduleFor('b'), moduleFor('c'), moduleFor('x')], edges: [
    edge('a', 'x', 'eager', './x'), edge('x', 'b', 'eager', './b-via-x'), edge('b', 'c', 'eager', './c'),
  ] };
  check(baseline, { entry: 'a', eagerCycles: [], allCycles: [] });
  check(transformed, { entry: 'a', eagerCycles: [], allCycles: [] });
});

test('subdividing a lazy closing edge keeps the cycle lazy', () => {
  const baseline = { entry: 'a', modules: [moduleFor('a'), moduleFor('b')], edges: [
    edge('a', 'b', 'eager', './b'), edge('b', 'a', 'lazy', './a'),
  ] };
  const transformed = { entry: 'a', modules: [moduleFor('a'), moduleFor('b'), moduleFor('x', 1, false)], edges: [
    edge('a', 'b', 'eager', './b'), edge('b', 'x', 'lazy', './x'), edge('x', 'a', 'eager', './a-via-x'),
  ] };
  check(baseline, { entry: 'a', eagerCycles: [], allCycles: [['a', 'b']] });
  check(transformed, { entry: 'a', eagerCycles: [], allCycles: [['a', 'b', 'x']] });
});

test('subdividing a self-loop creates a two-module cycle', () => {
  const baseline = { entry: 'a', modules: [moduleFor('a')], edges: [edge('a', 'a', 'eager', './self')] };
  const transformed = { entry: 'a', modules: [moduleFor('a'), moduleFor('x')], edges: [
    edge('a', 'x', 'eager', './x'), edge('x', 'a', 'eager', './a-via-x'),
  ] };
  check(baseline, { entry: 'a', eagerCycles: [['a']], allCycles: [['a']] });
  check(transformed, { entry: 'a', eagerCycles: [['a', 'x']], allCycles: [['a', 'x']] });
});

test('rejects a subdivided edge whose new endpoint is absent', () => {
  const report = { entry: 'a', modules: [moduleFor('a'), moduleFor('b')], edges: [
    edge('a', 'x', 'eager', './x'), edge('x', 'b', 'eager', './b-via-x'), edge('b', 'a', 'eager', './a'),
  ] };
  const result = invoke(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'FAIL: reference\n');
});
