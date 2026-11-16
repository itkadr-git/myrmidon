import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const count = 12000;
const middle = 6000;
const paths = Array.from({ length: count }, (_, i) => `module-${String(i).padStart(5, '0')}`);
const modules = paths.map(path => ({ path, bytes: 1, eager: true }));
const edges = paths.slice(1).map((path, i) => ({
  from: paths[i], specifier: path, kind: 'eager', to: path,
}));

function check(removedIndex, shortcut) {
  const report = { entry: paths[0], modules, edges: shortcut
    ? [...edges, { from: paths[middle - 1], specifier: 'bypass', kind: 'eager', to: paths[middle + 1] }]
    : edges };
  const result = spawnSync(process.execPath, [cli, paths[removedIndex]], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  const expected = shortcut ? [paths[removedIndex]] : paths.slice(removedIndex);
  assert.equal(output.entry, paths[0]);
  assert.equal(output.removed, paths[removedIndex]);
  assert.deepEqual(output.lostPaths, expected);
  assert.equal(output.lostBytes, expected.length);
  assert.equal(count - output.lostPaths.length, count - expected.length);
  assert.equal(count - output.lostBytes, count - expected.length);
}

test('deep chain cuts entry, middle and terminal at their index boundaries', () => {
  for (const index of [0, middle, count - 1]) check(index, false);
});

test('eager shortcut preserves the tail when the middle is removed', () => {
  check(middle, true);
});
