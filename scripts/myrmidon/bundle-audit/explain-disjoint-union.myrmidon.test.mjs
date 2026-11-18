import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-explain.mjs');
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to) => ({ from, specifier: to, kind: 'eager', to });
const cases = [
  {
    a: { entry: 'a0', modules: [m('a0', 1), m('a1', 2)], edges: [e('a0', 'a1')] },
    b: { entry: 'b0', modules: [m('b0', 3), m('b1', 4)], edges: [e('b0', 'b1')] },
    targetA: 'a1', targetB: 'b1',
    expectedA: { entry: 'a0', target: 'a1', reachable: true, path: ['a0', 'a1'] },
    unreachable: { entry: 'a0', target: 'b1', reachable: false, path: [] },
    expectedB: { entry: 'b0', target: 'b1', reachable: true, path: ['b0', 'b1'] },
  },
  {
    a: { entry: 'c0', modules: [m('c0', 7), m('c1', 9), m('c2', 11)], edges: [e('c0', 'c1'), e('c1', 'c2')] },
    b: { entry: 'd0', modules: [m('d0', 13), m('da', 15), m('db', 17), m('dt', 19)], edges: [e('d0', 'db'), e('d0', 'da'), e('da', 'dt'), e('db', 'dt')] },
    targetA: 'c2', targetB: 'dt',
    expectedA: { entry: 'c0', target: 'c2', reachable: true, path: ['c0', 'c1', 'c2'] },
    unreachable: { entry: 'c0', target: 'dt', reachable: false, path: [] },
    expectedB: { entry: 'd0', target: 'dt', reachable: true, path: ['d0', 'da', 'dt'] },
  },
  {
    a: { entry: 'x0', modules: [m('x0', 21), m('xt', 23)], edges: [e('x0', 'xt'), e('xt', 'x0')] },
    b: { entry: 'y0', modules: [m('y0', 25), m('ya', 27), m('yb', 29), m('yt', 31)], edges: [e('y0', 'ya'), e('ya', 'yb'), e('yb', 'yt'), e('y0', 'yt')] },
    targetA: 'xt', targetB: 'yt',
    expectedA: { entry: 'x0', target: 'xt', reachable: true, path: ['x0', 'xt'] },
    unreachable: { entry: 'x0', target: 'yt', reachable: false, path: [] },
    expectedB: { entry: 'y0', target: 'yt', reachable: true, path: ['y0', 'yt'] },
  },
];

function run(file, target) {
  return spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 10000 });
}
function success(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function error(result, category) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `error: ${category}\n`);
}

test('disjoint union preserves explanations and isolates known targets', () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'explain-union-'));
  try {
    const file = join(root, 'report.json');
    for (const { a, b, targetA, targetB, expectedA, expectedB, unreachable } of cases) {
      const unionA = { entry: a.entry, modules: [...a.modules, ...b.modules.map(item => ({ ...item, eager: false }))], edges: [...a.edges, ...b.edges] };
      const unionB = { entry: b.entry, modules: [...a.modules.map(item => ({ ...item, eager: false })), ...b.modules], edges: [...a.edges, ...b.edges] };
      for (const [report, checks] of [
        [a, [[targetA, expectedA]]], [b, [[targetB, expectedB]]],
        [unionA, [[targetA, expectedA], [targetB, unreachable]]],
        [unionB, [[targetB, expectedB]]],
      ]) {
        for (const reverse of [false, true]) {
          const input = JSON.stringify({ ...report, modules: reverse ? [...report.modules].reverse() : report.modules, edges: reverse ? [...report.edges].reverse() : report.edges });
          writeFileSync(file, input);
          for (const [target, expected] of checks) {
            for (let repeat = 0; repeat < 2; repeat++) success(run(file, target), expected);
          }
          assert.equal(readFileSync(file, 'utf8'), input);
        }
      }
      writeFileSync(file, JSON.stringify(unionA));
      error(run(file, 'absent'), 'target');
      writeFileSync(file, JSON.stringify({ ...unionA, edges: [...unionA.edges, e(a.entry, 'absent')] }));
      error(run(file, targetA), 'report');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
