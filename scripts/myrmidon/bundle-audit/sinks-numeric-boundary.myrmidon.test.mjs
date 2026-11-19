import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const max = BigInt(Number.MAX_SAFE_INTEGER);
const mod = (path, bytes) => ({ path, bytes: Number(bytes), eager: false });
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const report = (modules, edges = []) => ({ entry: modules[0].path, modules, edges });
const run = r => spawnSync(process.execPath, [cli], { input: JSON.stringify(r), encoding: 'utf8' });

function success(r, expected) {
  const result = run(r);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.entry, r.entry);
  assert.deepEqual(actual.sinks, expected.map(([path, bytes]) => ({ path, bytes: Number(bytes) })));
  assert.equal(String(actual.sinkBytes), expected.reduce((sum, [, bytes]) => sum + bytes, 0n).toString());
}

function failure(r, category) {
  const result = run(r);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

test('zero bytes', () => {
  success(report([mod('entry', 0n)]), [['entry', 0n]]);
});
test('one sink at the safe integer boundary', () => {
  success(report([mod('entry', max)]), [['entry', max]]);
});
test('two sinks sum exactly to the safe integer boundary', () => {
  const left = max / 2n, right = max - left;
  success(report([mod('entry', 0n), mod('left', left), mod('right', right)], [edge('entry', 'left'), edge('entry', 'right')]), [['left', left], ['right', right]]);
});
test('sum one above the boundary fails as graph without output', () => {
  const r = report([mod('entry', 0n), mod('left', max), mod('right', 1n)], [edge('entry', 'left'), edge('entry', 'right')]);
  assert.equal((max + 1n).toString(), '9007199254740992');
  failure(r, 'graph');
});
test('diamond counts its maximum sink once', () => {
  const r = report([mod('entry', 0n), mod('left', 0n), mod('right', 0n), mod('sink', max)], [edge('entry', 'left'), edge('entry', 'right'), edge('left', 'sink'), edge('right', 'sink')]);
  success(r, [['sink', max]]);
});
test('parallel aliases count their maximum sink once', () => {
  const r = report([mod('entry', 0n), mod('sink', max)], [edge('entry', 'sink', 'eager', 'first'), edge('entry', 'sink', 'eager', 'second')]);
  success(r, [['sink', max]]);
});
test('reachable non-sinks and disconnected or lazy-only vertices do not contribute', () => {
  const r = report([mod('entry', max), mod('middle', max), mod('sink', 3n), mod('disconnected', max), mod('lazy', max)], [edge('entry', 'middle'), edge('middle', 'sink'), edge('entry', 'lazy', 'lazy')]);
  success(r, [['sink', 3n]]);
});
for (const [label, bytes] of [['unsafe', Number(max + 1n)], ['fraction', 0.5], ['negative', -1]]) {
  for (const location of ['disconnected', 'lazy']) {
    test(`${label} bytes in ${location} vertex fail shape`, () => {
      const r = report([mod('entry', 0n), { path: 'outside', bytes, eager: false }], location === 'lazy' ? [edge('entry', 'outside', 'lazy')] : []);
      failure(r, 'shape');
    });
  }
}
