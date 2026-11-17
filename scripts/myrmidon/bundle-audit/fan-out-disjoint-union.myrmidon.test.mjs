import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const m = (path, bytes, eager = false) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const row = (path, bytes, targets, fanOut) => ({ path, bytes, targets, fanOut });

const cases = [
  {
    a: { entry: 'a', modules: [m('a', 1, true), m('aa', 2, true)], edges: [e('a', 'one', 'eager', 'aa'), e('a', 'alias', 'eager', 'aa')] },
    b: { entry: 'b', modules: [m('b', 3, true), m('bb', 4)], edges: [e('b', 'lazy', 'lazy', 'bb'), e('b', 'unknown', 'eager', null)] },
    expectedA: { entry: 'a', modules: [row('a', 1, ['aa'], 1), row('aa', 2, [], 0)] },
    expectedB: { entry: 'b', modules: [row('b', 3, [], 0), row('bb', 4, [], 0)] },
    expectedUnion: { entry: 'a', modules: [row('a', 1, ['aa'], 1), row('aa', 2, [], 0), row('b', 3, [], 0), row('bb', 4, [], 0)] },
  },
  {
    a: { entry: 'z', modules: [m('z', 5, true), m('za', 6, true), m('zb', 7, true)], edges: [e('z', 'second', 'eager', 'zb'), e('z', 'first', 'eager', 'za')] },
    b: { entry: 'c', modules: [m('c', 8, true), m('d', 9, true), m('isolated', 10)], edges: [e('c', 'd', 'eager', 'd'), e('d', 'c', 'eager', 'c')] },
    expectedA: { entry: 'z', modules: [row('z', 5, ['za', 'zb'], 2), row('za', 6, [], 0), row('zb', 7, [], 0)] },
    expectedB: { entry: 'c', modules: [row('c', 8, ['d'], 1), row('d', 9, ['c'], 1), row('isolated', 10, [], 0)] },
    expectedUnion: { entry: 'z', modules: [row('z', 5, ['za', 'zb'], 2), row('c', 8, ['d'], 1), row('d', 9, ['c'], 1), row('isolated', 10, [], 0), row('za', 6, [], 0), row('zb', 7, [], 0)] },
  },
  {
    a: { entry: 'root', modules: [m('root', 11, true), m('leaf', 12, true)], edges: [e('root', 'leaf', 'eager', 'leaf'), e('leaf', 'self', 'eager', 'leaf')] },
    b: { entry: 'other', modules: [m('other', 13, true), m('tail', 14, true), m('spare', 15)], edges: [e('other', 'tail', 'eager', 'tail'), e('other', 'alias', 'eager', 'tail'), e('tail', 'missing', 'lazy', null)] },
    expectedA: { entry: 'root', modules: [row('leaf', 12, ['leaf'], 1), row('root', 11, ['leaf'], 1)] },
    expectedB: { entry: 'other', modules: [row('other', 13, ['tail'], 1), row('spare', 15, [], 0), row('tail', 14, [], 0)] },
    expectedUnion: { entry: 'root', modules: [row('leaf', 12, ['leaf'], 1), row('other', 13, ['tail'], 1), row('root', 11, ['leaf'], 1), row('spare', 15, [], 0), row('tail', 14, [], 0)] },
  },
];

function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', cwd: homedir() });
}
function success(report, expected) {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

test('disjoint graph unions retain all independently specified fan-out rows', () => {
  for (const fixture of cases) {
    const before = JSON.stringify(fixture);
    const { a, b, expectedA, expectedB, expectedUnion } = fixture;
    const union = { entry: a.entry, modules: [...a.modules, ...b.modules], edges: [...a.edges, ...b.edges] };
    for (const [input, expected] of [[a, expectedA], [b, expectedB], [union, expectedUnion]]) {
      success(input, expected);
      success({ ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }, expected);
      success(input, expected);
    }
    assert.equal(JSON.stringify(fixture), before);
  }
});

test('missing edge endpoint has a sanitized graph error', () => {
  const report = { entry: 'a', modules: [m('a', 1, true)], edges: [e('a', 'safe', 'eager', 'synthetic-secret-sentinel')] };
  const before = JSON.stringify(report);
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes('synthetic-secret-sentinel'));
  assert.equal(JSON.stringify(report), before);
});
