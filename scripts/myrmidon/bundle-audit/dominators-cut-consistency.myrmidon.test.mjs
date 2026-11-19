import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cut = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const dominators = fileURLToPath(new URL('./import-report-dominators.mjs', import.meta.url));
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${to}` });
const report = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'gate', bytes: 0, eager: true },
    { path: 'left', bytes: 2, eager: true },
    { path: 'right', bytes: 3, eager: true },
    { path: 'target', bytes: 4, eager: true },
    { path: 'tail', bytes: 5, eager: true },
    { path: 'off', bytes: 8, eager: false },
  ],
  edges: [edge('entry', 'gate'), edge('gate', 'left'), edge('gate', 'right'),
    edge('left', 'target'), edge('right', 'target'), edge('target', 'tail'),
    edge('tail', 'target'), edge('entry', 'target', 'lazy')],
};

function run(cli, args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}
function cutResult(input, removed, lostPaths, lostBytes) {
  const result = run(cut, [removed], input);
  success(result, { entry: 'entry', removed, lostPaths, lostBytes });
  return JSON.parse(result.stdout);
}
function domResult(input, expected) {
  const result = run(dominators, ['-', 'target'], input);
  success(result, { entry: 'entry', target: 'target', dominators: expected });
  return JSON.parse(result.stdout).dominators;
}

test('dominators exactly identify eager cuts that disconnect the target', () => {
  const dom = domResult(report, ['entry', 'gate', 'target']);
  const cases = [
    ['entry', ['entry', 'gate', 'left', 'right', 'tail', 'target'], 15],
    ['gate', ['gate', 'left', 'right', 'tail', 'target'], 14],
    ['left', ['left'], 2],
    ['right', ['right'], 3],
    ['target', ['tail', 'target'], 9],
    ['tail', ['tail'], 5],
    ['off', [], 0],
  ];
  for (const [removed, paths, bytes] of cases) {
    const result = cutResult(report, removed, paths, bytes);
    assert.equal(result.lostPaths.includes('target'), dom.includes(removed), removed);
  }
  const off = run(dominators, ['-', 'off'], report);
  assert.equal(off.status, 1);
  assert.equal(off.stdout, '');
  assert.equal(off.stderr, 'graph\n');
});

test('an eager bypass removes gate from the target dominators and cut', () => {
  const bypass = { ...report, edges: [...report.edges, edge('entry', 'right')] };
  const dom = domResult(bypass, ['entry', 'target']);
  const result = cutResult(bypass, 'gate', ['gate', 'left'], 2);
  assert.equal(result.lostPaths.includes('target'), dom.includes('gate'));
});
