import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const extension = { annotation: { sentinel: 'producer-extension', flag: true, empty: null, values: [false, null, { deep: ['kept'] }] } };
const moduleRow = (path, bytes, eager) => ({ path, bytes, eager, ...structuredClone(extension) });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to, ...structuredClone(extension) });
const report = {
  entry: 'entry', reportAnnotation: { sentinel: 'not-projected' },
  modules: [moduleRow('entry', 11, true), moduleRow('Z', 7, true), moduleRow('lazy', 5, false), moduleRow('disconnected', 3, false), moduleRow('leaf', 2, false)],
  edges: [edge('entry', 'z', 'eager', 'Z'), edge('entry', 'lazy', 'lazy', 'lazy'), edge('Z', 'unknown', 'eager', null), edge('disconnected', 'leaf', 'eager', 'leaf'), edge('disconnected', 'unknown', 'eager', null), edge('disconnected', 'lazy', 'lazy', 'lazy')],
};
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function expectedProjection(input, root, mode) {
  const reached = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of input.edges) {
      if (reached.has(item.from) && (mode === 'all' || item.kind === 'eager') && item.to !== null && !reached.has(item.to)) {
        reached.add(item.to); changed = true;
      }
    }
  }
  const modules = input.modules.filter(item => reached.has(item.path)).sort((a, b) => cmp(a.path, b.path));
  const edges = input.edges.filter(item => reached.has(item.from) && (mode === 'all' || item.kind === 'eager'));
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.kind, b.kind) || (a.to === b.to ? 0 : a.to === null ? -1 : b.to === null ? 1 : cmp(a.to, b.to)));
  return { root, mode, modules, edges, unknown: edges.filter(item => item.to === null) };
}
function fixture(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-extensions-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return join(tmp, 'report.json');
}
function run(file, root, mode) {
  return spawnSync(process.execPath, [cli, file, root, mode], { encoding: 'utf8', timeout: 10000 });
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function invoke(file, input, root, mode) {
  const before = JSON.stringify(input);
  writeFileSync(file, before);
  const result = run(file, root, mode);
  assert.equal(readFileSync(file, 'utf8'), before);
  return result;
}

test('projection preserves producer extensions across roots, modes, permutations and repeated runs', t => {
  const file = fixture(t);
  for (const root of ['entry', 'disconnected']) for (const mode of ['eager', 'all']) {
    const expected = expectedProjection(report, root, mode);
    assert.ok(expected.modules.length > 0 && expected.edges.length > 0 && expected.unknown.length > 0);
    assert.ok(expected.modules.every(item => item.annotation.sentinel === 'producer-extension'));
    assert.ok(expected.edges.every(item => item.annotation.sentinel === 'producer-extension'));
    const variants = [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }];
    for (const input of variants) for (let repeat = 0; repeat < 2; repeat++) {
      const result = invoke(file, input, root, mode);
      success(result, expected);
      const corrupted = structuredClone(expected);
      corrupted.modules[0].bytes++;
      assert.throws(() => success(result, corrupted), assert.AssertionError);
    }
  }
});

test('extensions do not weaken shape and duplicate tuple validation', t => {
  const file = fixture(t);
  const invalidBytes = structuredClone(report);
  invalidBytes.modules[0].bytes = -1;
  const duplicate = structuredClone(report);
  duplicate.edges.push(structuredClone(duplicate.edges[0]));
  for (const [input, stderr] of [[invalidBytes, 'shape error\n'], [duplicate, 'graph error\n']]) {
    const result = invoke(file, input, 'entry', 'all');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, stderr);
  }
});
