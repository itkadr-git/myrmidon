import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const size = 16000;
const path = i => `node-${String(i).padStart(5, '0')}`;
const moduleAt = i => ({ path: path(i), bytes: i + 10, eager: true });
const resultAt = (i, targets = []) => ({ path: path(i), bytes: i + 10, targets, fanOut: targets.length });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function run(report) {
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, TMPDIR: process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^[^\n]+\n$/);
  return JSON.parse(result.stdout);
}

function checkPermutations(report, expected) {
  for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const actual = run(input);
    assert.equal(actual.modules[0].fanOut, expected.modules[0].fanOut);
    assert.deepEqual(actual, expected);
  }
}

test('wide direct fan-out deduplicates aliases and excludes lazy and unknown edges', { timeout: 180000 }, () => {
  const targets = Array.from({ length: size }, (_, i) => path(i));
  const modules = Array.from({ length: size }, (_, i) => moduleAt(i));
  const isolated = Array.from({ length: 3 }, (_, i) => ({ path: `isolated-${i}`, bytes: i + 1, eager: false }));
  const edges = targets.flatMap((target, i) => [
    edge('entry', `alias-a-${i}`, 'eager', target),
    edge('entry', `alias-b-${i}`, 'eager', target),
  ]);
  edges.push(edge('entry', 'lazy-isolated', 'lazy', isolated[0].path), edge('entry', 'unknown', 'eager', null));
  const report = { entry: 'entry', modules: [{ path: 'entry', bytes: 7, eager: true }, ...modules, ...isolated], edges };
  const expected = { entry: 'entry', modules: [
    { path: 'entry', bytes: 7, targets, fanOut: size },
    ...isolated.map(mod => ({ path: mod.path, bytes: mod.bytes, targets: [], fanOut: 0 })),
    ...Array.from({ length: size }, (_, i) => resultAt(i)),
  ] };
  checkPermutations(report, expected);
});

test('long chain reports only immediate targets', () => {
  const modules = Array.from({ length: size }, (_, i) => moduleAt(i));
  const edges = Array.from({ length: size - 1 }, (_, i) => edge(path(i), `next-${i}`, 'eager', path(i + 1)));
  const report = { entry: path(0), modules, edges };
  const expected = { entry: path(0), modules: [
    ...Array.from({ length: size - 1 }, (_, i) => resultAt(i, [path(i + 1)])),
    resultAt(size - 1),
  ] };
  checkPermutations(report, expected);
});
