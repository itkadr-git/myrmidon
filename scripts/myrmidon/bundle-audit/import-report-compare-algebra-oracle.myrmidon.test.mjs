import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));
const entry = 'entry.mjs';
const max = Number.MAX_SAFE_INTEGER;
// Each state is a path -> [bytes, eager] fixture, independent of the CLI.
const states = [
  {},
  { z: [0, false], old: [7, true], same: [2, false] },
  { a: [0, true], new: [7, true], same: [2, false] },
  { z: [3, true], old: [4, false], same: [2, false] },
  { z: [0, true], old: [7, true], same: [2, false] },
  { huge: [max, true] },
  { huge: [max - 1, false], zero: [0, true] },
];
const paths = object => Object.keys(object).sort();
function totals(state) {
  const values = Object.values(state);
  return {
    modules: values.length,
    eagerModules: values.filter(([, eager]) => eager).length,
    totalBytes: values.reduce((sum, [bytes]) => sum + bytes, 0),
    eagerBytes: values.reduce((sum, [bytes, eager]) => sum + (eager ? bytes : 0), 0),
  };
}
function report(state, reverse = false) {
  const names = paths(state);
  if (reverse) names.reverse();
  const modules = names.map(path => ({ path, bytes: state[path][0], eager: state[path][1] }));
  const t = totals(state);
  return { entry, modules, counts: { modules: t.modules, eagerModules: t.eagerModules }, bytes: { total: t.totalBytes, eager: t.eagerBytes } };
}
function oracle(before, after) {
  const left = totals(before), right = totals(after);
  const delta = Object.fromEntries(Object.keys(left).map(key => [key, right[key] - left[key]]));
  const added = [], removed = [], changed = [];
  for (const path of [...new Set([...paths(before), ...paths(after)])].sort()) {
    const a = before[path], b = after[path];
    if (!a) added.push({ path, bytes: b[0], eager: b[1] });
    else if (!b) removed.push({ path, bytes: a[0], eager: a[1] });
    else if (a[0] !== b[0] || a[1] !== b[1]) changed.push({ path, before: { bytes: a[0], eager: a[1] }, after: { bytes: b[0], eager: b[1] } });
  }
  return { entry, delta, added, removed, changed };
}

test('independent partitions and delta algebra over fixture maps', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.HOME;
  assert.ok(root, 'run scratch directory or HOME required');
  const dir = mkdtempSync(join(root, 'compare-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = states.map((state, i) => [false, true].map(reverse => {
    const file = join(dir, `${i}-${reverse}.json`);
    writeFileSync(file, JSON.stringify(report(state, reverse)));
    return file;
  }));
  function compare(i, j, reverse = false) {
    const result = spawnSync(process.execPath, [cli, files[i][+reverse], files[j][+reverse]], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  const results = states.map((a, i) => states.map((b, j) => {
    const actual = compare(i, j);
    assert.deepEqual(actual, oracle(a, b), `pair ${i},${j}`);
    assert.deepEqual(compare(i, j, true), actual, `permutation ${i},${j}`);
    return actual;
  }));
  for (let i = 0; i < states.length; i++) {
    for (let j = 0; j < states.length; j++) {
      for (const key of Object.keys(results[i][j].delta)) {
        assert.equal(results[i][j].delta[key] + results[j][i].delta[key], 0, `antisymmetry ${i},${j} ${key}`);
        for (let k = 0; k < states.length; k++) {
          const sum = results[i][j].delta[key] + results[j][k].delta[key];
          if (Number.isSafeInteger(sum)) assert.equal(results[i][k].delta[key], sum, `composition ${i},${j},${k} ${key}`);
        }
      }
    }
  }
});
