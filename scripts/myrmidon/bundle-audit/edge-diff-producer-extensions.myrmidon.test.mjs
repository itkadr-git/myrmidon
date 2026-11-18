import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const modules = [{ path: 'entry', bytes: 42, eager: true }, { path: 'a', bytes: 17, eager: false }, { path: 'b', bytes: 9, eager: false }];
const base = { entry: 'entry', modules, edges: [edge('entry', 'same', 'lazy', 'a'), edge('entry', 'old', 'lazy', null), edge('a', 'z', 'lazy', 'b')] };
const current = { entry: 'entry', modules, edges: [edge('entry', 'same', 'lazy', 'a'), edge('entry', 'new', 'lazy', 'b'), edge('b', 'x', 'lazy', null)] };
const tuple = e => [e.from, e.specifier, e.kind, e.to];
const key = e => JSON.stringify(tuple(e));
const compare = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
const compareTuple = (a, b) => {
  const left = tuple(a), right = tuple(b);
  for (let i = 0; i < left.length; i++) { const order = compare(left[i], right[i]); if (order) return order; }
  return 0;
};
function oracle(a, b) {
  const difference = (left, right) => {
    const other = new Set(right.edges.map(key));
    return left.edges.filter(e => !other.has(key(e))).map(e => edge(...tuple(e))).sort(compareTuple);
  };
  return { entry: a.entry, added: difference(b, a), removed: difference(a, b) };
}
function annotated(report, marker) {
  const extension = { sentinel: `sentinel-${marker}`, values: [null, true, false, { nested: [marker, null] }] };
  return { ...report, producerExtra: extension, modules: report.modules.map(m => ({ ...m, moduleExtra: extension })), edges: report.edges.map(e => ({ ...e, edgeExtra: extension })) };
}
function reversed(report) { return { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }; }
function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'producer-extensions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
}
function invoke(a, b) {
  const before = [readFileSync(a), readFileSync(b)];
  const result = spawnSync(process.execPath, [cli, a, b], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(readFileSync(a), before[0]);
  assert.deepEqual(readFileSync(b), before[1]);
  return result;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
}

test('producer extensions preserve exact edge differences across order, direction and repeated runs', t => {
  const put = fixture(t);
  const expected = oracle(base, current);
  assert.ok(expected.added.length && expected.removed.length);
  const variants = [[annotated(base, 'base'), current], [base, annotated(current, 'current')], [annotated(base, 'base'), annotated(current, 'current')]];
  for (const [i, [a, b]] of variants.entries()) {
    for (const [j, [left, right]] of [[a, b], [reversed(a), reversed(b)], [reversed(a), b], [a, reversed(b)]].entries()) {
      const x = put(`base-${i}-${j}`, left), y = put(`current-${i}-${j}`, right);
      for (let repeat = 0; repeat < 2; repeat++) success(invoke(x, y), expected);
      success(invoke(y, x), { entry: expected.entry, added: expected.removed, removed: expected.added });
    }
  }
  const original = put('original', base), annotations = put('annotations', reversed(annotated(base, 'only')));
  success(invoke(original, annotations), { entry: 'entry', added: [], removed: [] });
  success(invoke(annotations, original), { entry: 'entry', added: [], removed: [] });
  const actual = invoke(put('control-base', base), put('control-current', current));
  const corrupted = { ...expected, added: expected.added.slice(1) };
  assert.throws(() => success(actual, corrupted), assert.AssertionError);
});

test('extensions do not bypass module and duplicate edge validation', t => {
  const put = fixture(t);
  const good = annotated(base, 'good');
  const invalidBytes = annotated(base, 'bad-bytes');
  invalidBytes.modules[0].bytes = -1;
  const duplicate = annotated(base, 'duplicate');
  duplicate.edges.push({ ...duplicate.edges[0], edgeExtra: { sentinel: 'different' } });
  const goodPath = put('good', good);
  for (const [name, value, error] of [['bytes', invalidBytes, 'invalid module'], ['duplicate', duplicate, 'duplicate edge']]) {
    const badPath = put(name, value);
    for (const [a, b] of [[goodPath, badPath], [badPath, goodPath]]) {
      const result = invoke(a, b);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${error}\n`);
    }
  }
});
