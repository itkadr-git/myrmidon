import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const moduleOf = (path, bytes) => ({ path, bytes, eager: true });
const edge = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });
const run = report => spawnSync(process.execPath, [cli, 'cut'], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const report = (modules, edges) => ({ entry: 'entry', modules, edges });
const success = (result, lostPaths, lostBytes) => {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: 'entry', removed: 'cut', lostPaths, lostBytes }) + '\n');
};
const failure = (result, category) => {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, category + '\n');
};

test('counts maximum safe lost bytes once despite aliases and large retained or disconnected modules', () => {
  const input = report([
    moduleOf('entry', Number.MAX_SAFE_INTEGER), moduleOf('cut', 0),
    moduleOf('lost', Number.MAX_SAFE_INTEGER), moduleOf('off', Number.MAX_SAFE_INTEGER),
  ], [edge('entry', 'cut', 'cut'), edge('cut', 'one', 'lost'), edge('cut', 'two', 'lost')]);
  success(run(input), ['cut', 'lost'], Number.MAX_SAFE_INTEGER);
});

test('zero bytes and multiple additions at the safe boundary are exact', () => {
  const input = report([
    moduleOf('entry', 0), moduleOf('cut', 0), moduleOf('a', Number.MAX_SAFE_INTEGER - 3),
    moduleOf('b', 1), moduleOf('c', 2), moduleOf('z', 0),
  ], [edge('entry', 'cut', 'cut'), edge('cut', 'a', 'a'), edge('cut', 'b', 'b'), edge('cut', 'c', 'c'), edge('cut', 'z', 'z')]);
  success(run(input), ['a', 'b', 'c', 'cut', 'z'], Number.MAX_SAFE_INTEGER);
  success(run(report([moduleOf('entry', 0), moduleOf('cut', 0)], [edge('entry', 'cut', 'cut')])), ['cut'], 0);
});

test('overflow by one and overflow after multiple additions report graph only', () => {
  for (const sizes of [[Number.MAX_SAFE_INTEGER, 1], [Number.MAX_SAFE_INTEGER - 3, 2, 2]]) {
    const modules = [moduleOf('entry', 0), moduleOf('cut', 0), ...sizes.map((bytes, i) => moduleOf(`n${i}`, bytes))];
    const edges = [edge('entry', 'cut', 'cut'), ...sizes.map((_, i) => edge('cut', `n${i}`, `n${i}`))];
    failure(run(report(modules, edges)), 'graph');
  }
});

test('invalid module byte values report shape only', () => {
  for (const bytes of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
    failure(run(report([moduleOf('entry', 0), moduleOf('cut', bytes)], [edge('entry', 'cut', 'cut')])), 'shape');
  }
});
