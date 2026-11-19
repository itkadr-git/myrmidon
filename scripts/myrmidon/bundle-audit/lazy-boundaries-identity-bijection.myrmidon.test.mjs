import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 11, eager: true },
    { path: 'a', bytes: 13, eager: true },
    { path: 'b', bytes: 17, eager: true },
    { path: 'lazy', bytes: 19, eager: false },
    { path: 'deep', bytes: 23, eager: false },
    { path: 'other', bytes: 29, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: './a', kind: 'eager', to: 'a' },
    { from: 'a', specifier: './b', kind: 'eager', to: 'b' },
    { from: 'entry', specifier: './alternate', kind: 'lazy', to: 'b' },
    { from: 'lazy', specifier: './deep', kind: 'lazy', to: 'deep' },
    { from: 'a', specifier: './feature', kind: 'lazy', to: 'lazy' },
    { from: 'b', specifier: './other', kind: 'lazy', to: 'other' },
    { from: 'entry', specifier: 'external', kind: 'lazy', to: null },
  ],
};
// This oracle describes the two reachable lazy-only targets, not CLI output.
const expected = {
  entry: 'entry',
  boundaries: [
    { from: 'a', specifier: './feature', to: 'lazy', bytes: 19 },
    { from: 'b', specifier: './other', to: 'other', bytes: 29 },
  ],
};
const names = ['entry', 'a', 'b', 'lazy', 'deep', 'other'];
const mappings = [
  ['root', 'z', 'y', 'x', 'w', 'v'],
  ['dir/root.mjs', 'z/a.mjs', 'a/b.mjs', 'pkg/lazy.mjs', 'pkg/deep.mjs', 'nested/other.mjs'],
  ['\u6839', '\u03c9', '\u03b1', '\u96ea/\u6708', '\u00e9/deep', '\u732b/other'],
];
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortRows = rows => rows.sort((a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier) || cmp(a.to, b.to));

function rename(report, map) {
  const id = value => value === null ? null : map.get(value);
  return {
    ...report,
    entry: id(report.entry),
    modules: report.modules.map(mod => ({ ...mod, path: id(mod.path) })),
    edges: report.edges.map(edge => ({ ...edge, from: id(edge.from), to: id(edge.to) })),
  };
}

function run(path) {
  return spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
}

function check(path, report, inverse) {
  const input = JSON.stringify(report);
  writeFileSync(path, input);
  const first = run(path), second = run(path);
  for (const result of [first, second]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(first.stdout, second.stdout);
  const output = JSON.parse(first.stdout);
  const normalized = {
    ...output,
    entry: inverse.get(output.entry),
    boundaries: sortRows(output.boundaries.map(row => ({ ...row, from: inverse.get(row.from), to: inverse.get(row.to) }))),
  };
  assert.deepEqual(normalized, expected);
  assert.equal(readFileSync(path, 'utf8'), input);
}

test('bijective module renames preserve exact startup boundaries', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'identity-bijection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  const original = JSON.stringify(fixture);
  check(path, fixture, new Map(names.map(name => [name, name])));
  for (const targets of mappings) {
    assert.equal(new Set(targets).size, names.length);
    const forward = new Map(names.map((name, i) => [name, targets[i]]));
    const inverse = new Map(names.map((name, i) => [targets[i], name]));
    check(path, rename(fixture, forward), inverse);
  }
  assert.equal(JSON.stringify(fixture), original);
  const collision = new Map(names.map(name => [name, name]));
  collision.set('a', 'b');
  writeFileSync(path, JSON.stringify(rename(fixture, collision)));
  const rejected = run(path);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr, 'graph\n');
});
