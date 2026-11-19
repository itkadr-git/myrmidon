import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-redundant-edges.mjs', import.meta.url).pathname;
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const graph = (paths, edges) => ({ entry: 'u', modules: paths.map(path => ({ path, bytes: 0, eager: true })), edges });
const candidate = (from, specifier, to, alternativePath) => ({ from, specifier, to, alternativePath });

function check(report, redundant) {
  const before = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  const expected = JSON.stringify({ entry: 'u', redundant }) + '\n';
  for (const input of [report, report, reversed]) {
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
    assert.deepEqual(JSON.parse(result.stdout), { entry: 'u', redundant });
  }
  assert.equal(JSON.stringify(report), before);
}

test('subdivision extends the redundant triangle path', () => {
  check(graph(['u', 'w', 'v'], [edge('u', 'v', 'uv'), edge('u', 'w', 'uw'), edge('w', 'v', 'wv')]),
    [candidate('u', 'uv', 'v', ['u', 'w', 'v'])]);
  check(graph(['u', 'w', 'x', 'v'], [edge('u', 'v', 'uv'), edge('u', 'w', 'uw'), edge('w', 'x', 'wx'), edge('x', 'v', 'xv')]),
    [candidate('u', 'uv', 'v', ['u', 'w', 'x', 'v'])]);
});

test('shorter alternative wins after subdivision, then lexical tie breaks', () => {
  check(graph(['u', 'a', 'b', 'v'], [edge('u', 'v', 'uv'), edge('u', 'a', 'ua'), edge('a', 'v', 'av'), edge('u', 'b', 'ub'), edge('b', 'v', 'bv')]),
    [candidate('u', 'uv', 'v', ['u', 'a', 'v'])]);
  check(graph(['u', 'a', 'b', 'x', 'v'], [edge('u', 'v', 'uv'), edge('u', 'a', 'ua'), edge('a', 'x', 'ax'), edge('x', 'v', 'xv'), edge('u', 'b', 'ub'), edge('b', 'v', 'bv')]),
    [candidate('u', 'uv', 'v', ['u', 'b', 'v'])]);
  check(graph(['u', 'a', 'b', 'v'], [edge('u', 'v', 'uv'), edge('u', 'a', 'ua'), edge('a', 'v', 'av'), edge('u', 'b', 'ub'), edge('b', 'v', 'bv')]),
    [candidate('u', 'uv', 'v', ['u', 'a', 'v'])]);
  check(graph(['u', 'a', 'b', 'x', 'v'], [edge('u', 'v', 'uv'), edge('u', 'a', 'ua'), edge('a', 'v', 'av'), edge('u', 'b', 'ub'), edge('b', 'x', 'bx'), edge('x', 'v', 'xv')]),
    [candidate('u', 'uv', 'v', ['u', 'a', 'v'])]);
});

test('subdividing the only chain edge creates no redundancy', () => {
  check(graph(['u', 'v'], [edge('u', 'v', 'uv')]), []);
  check(graph(['u', 'x', 'v'], [edge('u', 'x', 'ux'), edge('x', 'v', 'xv')]), []);
});

test('a lazy segment is not an eager alternative', () => {
  check(graph(['u', 'w', 'v'], [edge('u', 'v', 'uv'), edge('u', 'w', 'uw'), edge('w', 'v', 'wv', 'lazy')]), []);
  check(graph(['u', 'w', 'x', 'v'], [edge('u', 'v', 'uv'), edge('u', 'w', 'uw'), edge('w', 'x', 'wx'), edge('x', 'v', 'xv', 'lazy')]), []);
});

test('missing subdivision endpoint is rejected without stdout', () => {
  const invalid = graph(['u', 'v'], [edge('u', 'x', 'ux'), edge('x', 'v', 'xv')]);
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(invalid), encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, null);
  assert.equal(result.stdout, '');
});
