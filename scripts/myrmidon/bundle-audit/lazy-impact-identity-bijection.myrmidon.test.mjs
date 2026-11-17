import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 10, eager: true },
    { path: 'a', bytes: 20, eager: true },
    { path: 'b', bytes: 30, eager: true },
    { path: 'shared', bytes: 3, eager: true },
    { path: 'cycle', bytes: 7, eager: true },
    { path: 'lazy', bytes: 4, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: './chosen', to: 'a', kind: 'eager' },
    { from: 'entry', specifier: './neighbor', to: 'b', kind: 'eager' },
    { from: 'a', specifier: './shared', to: 'shared', kind: 'eager' },
    { from: 'b', specifier: './shared', to: 'shared', kind: 'eager' },
    { from: 'a', specifier: './cycle', to: 'cycle', kind: 'eager' },
    { from: 'cycle', specifier: './back', to: 'a', kind: 'eager' },
    { from: 'entry', specifier: './later', to: 'lazy', kind: 'lazy' },
    { from: 'entry', specifier: 'external', to: null, kind: 'eager' },
  ],
};
const mappings = [
  { entry: 'root', a: 'z', b: 'y', shared: 'common', cycle: 'x', lazy: 'later' },
  { entry: 'nested/start', a: 'nested/z', b: 'nested/a', shared: 'lib/shared', cycle: 'lib/cycle', lazy: 'nested/lazy' },
  { entry: '\u03bb/start', a: '\u96ea/z', b: '\u00e9/a', shared: '\u03bb/common', cycle: '\u96ea/cycle', lazy: '\u00e9/lazy' },
];
const expected = {
  entry: 'entry', selected: { from: 'entry', specifier: './chosen', to: 'a' },
  before: { modules: 5, bytes: 70 }, after: { modules: 3, bytes: 43 },
  removedPaths: ['a', 'cycle'], savedBytes: 27,
};

function rename(report, mapping) {
  const id = value => value === null ? null : mapping[value];
  return {
    ...report, entry: id(report.entry),
    modules: report.modules.map(mod => ({ ...mod, path: id(mod.path) })),
    edges: report.edges.map(edge => ({ ...edge, from: id(edge.from), to: id(edge.to) })),
  };
}
function normalize(result, mapping) {
  const inverse = Object.fromEntries(Object.entries(mapping).map(([a, b]) => [b, a]));
  return {
    ...result, entry: inverse[result.entry],
    selected: { ...result.selected, from: inverse[result.selected.from], to: inverse[result.selected.to] },
    removedPaths: result.removedPaths.map(path => inverse[path]).sort(),
  };
}
function invoke(dir, report, from) {
  const path = join(dir, 'report.json');
  const text = JSON.stringify(report);
  writeFileSync(path, text);
  const result = spawnSync(process.execPath, [cli, path, from, './chosen'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readFileSync(path, 'utf8'), text);
  return result;
}
function success(dir, report, from, expectedResult, mapping) {
  const result = invoke(dir, report, from);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(mapping ? normalize(parsed, mapping) : parsed, expectedResult);
  if (mapping) assert.deepEqual(parsed.removedPaths, [...parsed.removedPaths].sort());
  const repeat = invoke(dir, report, from);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stderr, '');
  assert.equal(repeat.stdout, result.stdout);
}

test('identity bijections preserve selected edge and complete impact with and without an alternate route', t => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'identity-bijection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = JSON.stringify(fixture);
  const alternate = { ...fixture, edges: [...fixture.edges, { from: 'entry', specifier: './alternate', to: 'a', kind: 'eager' }] };
  for (const [report, oracle] of [
    [fixture, expected],
    [alternate, { ...expected, after: { modules: 5, bytes: 70 }, removedPaths: [], savedBytes: 0 }],
  ]) {
    success(dir, report, 'entry', oracle);
    for (const mapping of mappings) {
      assert.equal(new Set(Object.values(mapping)).size, fixture.modules.length);
      success(dir, rename(report, mapping), mapping.entry, oracle, mapping);
    }
  }
  assert.equal(JSON.stringify(fixture), original);
  const collision = { ...mappings[0], b: mappings[0].a };
  const bad = invoke(dir, rename(fixture, collision), collision.entry);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, 'error: graph\n');
});
