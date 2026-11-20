import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier = to, kind = 'eager') => ({ from, to, specifier, kind });
const expected = (paths, bytes) => ({ entry: 'e', removed: 'a', lostPaths: paths, lostBytes: bytes });

function check(report, result) {
  const input = JSON.stringify(report);
  const run = spawnSync(process.execPath, [cli, 'a'], { input, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, `${JSON.stringify(result)}\n`);
  assert.equal(JSON.stringify(report), input);
}

function matrix(before, after, beforeExpected, afterExpected) {
  for (const [report, result] of [[before, beforeExpected], [after, afterExpected], [after, afterExpected], [before, beforeExpected]]) {
    check(report, result);
    check({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, result);
  }
}

const modules = () => [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3), moduleOf('t', 4)];

test('diamond: deleting the alternate edge makes the target lost', () => {
  const before = { entry: 'e', modules: modules(), edges: [edge('e', 'a'), edge('e', 'b'), edge('a', 't'), edge('b', 't')] };
  const after = { ...before, edges: before.edges.filter(x => !(x.from === 'b' && x.to === 't')) };
  matrix(before, after, expected(['a'], 2), expected(['a', 't'], 6));

  const lazy = edge('b', 't', 'lazy-shortcut', 'lazy');
  const unknown = edge('b', null, 'unknown');
  check({ ...after, edges: [...after.edges, lazy, unknown] }, expected(['a', 't'], 6));
  check({ ...after, edges: [...after.edges, unknown] }, expected(['a', 't'], 6));
  check({ ...after, edges: [...after.edges, lazy] }, expected(['a', 't'], 6));

  const alias = edge('b', 't', 'alias');
  check({ ...before, edges: [...before.edges, alias] }, expected(['a'], 2));
  check({ ...after, edges: [...after.edges, alias] }, expected(['a'], 2));
});

test('chain: deleting the only edge to target removes it from baseline', () => {
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('t', 4)], edges: [edge('e', 'a'), edge('a', 't')] };
  const after = { ...before, modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('t', 4, false)], edges: [edge('e', 'a')] };
  matrix(before, after, expected(['a', 't'], 6), expected(['a'], 2));
});

test('cycle: deleting the alternate entrance leaves the cycle behind the cut', () => {
  const before = { entry: 'e', modules: modules(), edges: [edge('e', 'a'), edge('a', 't'), edge('t', 'b'), edge('b', 't'), edge('e', 'b')] };
  const after = { ...before, edges: before.edges.filter(x => !(x.from === 'e' && x.to === 'b')) };
  matrix(before, after, expected(['a'], 2), expected(['a', 'b', 't'], 9));
});

test('missing edge endpoint fails as graph without leaking input', () => {
  const sentinel = 'private-edge-sentinel';
  const report = { entry: 'e', modules: modules(), edges: [edge('e', sentinel)] };
  const original = JSON.stringify(report);
  const run = spawnSync(process.execPath, [cli, 'a'], { input: original, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, 'graph\n');
  assert.equal(JSON.stringify(report), original);
});
