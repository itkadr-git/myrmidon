import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const edge = (from, specifier, to, kind = 'eager') => ({ from, specifier, to, kind });
function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-identity');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
}
function run(file, report, from, specifier) {
  const text = JSON.stringify(report);
  writeFileSync(file, text);
  const result = spawnSync(process.execPath, [cli, file, from, specifier], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(readFileSync(file, 'utf8'), text);
  return result;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `error: ${category}\n`);
}

test('selects exact identities across similar paths, delimiters, Unicode and prototype names', t => {
  const file = fixture(t);
  const paths = ['entry', 'a|b', 'a', 'a/b', 'a\\b', '__proto__', 'constructor', '\u00e9', 'e\u0301', 'target'];
  const report = { entry: 'entry', modules: paths.map(path => ({ path, bytes: path === 'target' ? 7 : 1, eager: true })), edges: [
    ...paths.slice(1, -1).map((path, i) => edge('entry', `link${i}`, path)),
    edge('a|b', 'c', 'target'), edge('a', 'b|c', 'target'),
    edge('a/b', 'x\\y', 'target'), edge('a\\b', 'x/y', 'target'),
    edge('__proto__', 'constructor', 'target'), edge('constructor', '__proto__', 'target'),
    edge('\u00e9', '\u00e9', 'target'), edge('e\u0301', 'e\u0301', 'target'),
  ] };
  const pairs = [['a|b', 'c'], ['a', 'b|c'], ['a/b', 'x\\y'], ['a\\b', 'x/y'], ['__proto__', 'constructor'], ['constructor', '__proto__'], ['\u00e9', '\u00e9'], ['e\u0301', 'e\u0301']];
  for (const [from, specifier] of pairs) {
    const expected = { entry: 'entry', selected: { from, specifier, to: 'target' }, before: { modules: 10, bytes: 16 }, after: { modules: 10, bytes: 16 }, removedPaths: [], savedBytes: 0 };
    for (const permutation of [false, true, true]) {
      const input = permutation ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
      success(run(file, input, from, specifier), expected);
    }
  }
  for (const [from, specifier] of [['a|b', 'b|c'], ['a/b', 'x/y'], ['a\\b', 'x\\y'], ['\u00e9', 'e\u0301']]) failure(run(file, report, from, specifier), 'selection');
});

test('selection distinguishes ambiguous, absent, lazy and unresolved edges from duplicate tuples', t => {
  const file = fixture(t);
  const base = { entry: 'entry', modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: 3, eager: true }], edges: [edge('entry', 'one', 'a'), edge('entry', 'two', 'b')] };
  const expected = { entry: 'entry', selected: { from: 'entry', specifier: 'one', to: 'a' }, before: { modules: 3, bytes: 6 }, after: { modules: 2, bytes: 4 }, removedPaths: ['a'], savedBytes: 2 };
  success(run(file, base, 'entry', 'one'), expected);
  const shared = { ...base, edges: [...base.edges, edge('entry', 'alternate', 'a')] };
  success(run(file, shared, 'entry', 'one'), { ...expected, after: { modules: 3, bytes: 6 }, removedPaths: [], savedBytes: 0 });
  failure(run(file, { ...base, edges: [...base.edges, edge('entry', 'one', 'b')] }, 'entry', 'one'), 'selection');
  failure(run(file, base, 'entry', 'absent'), 'selection');
  failure(run(file, { ...base, edges: [...base.edges, edge('entry', 'lazy', 'a', 'lazy')] }, 'entry', 'lazy'), 'selection');
  failure(run(file, { ...base, edges: [...base.edges, edge('entry', 'external', null)] }, 'entry', 'external'), 'selection');
  failure(run(file, { ...base, edges: [...base.edges, { ...base.edges[0] }] }, 'entry', 'one'), 'graph');
});
