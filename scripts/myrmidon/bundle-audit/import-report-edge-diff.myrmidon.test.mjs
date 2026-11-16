import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-edge-diff.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-diff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, put(name, value) { const path = join(dir, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; } };
}
const mod = (path, eager = false) => ({ path, bytes: 1, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const report = (edges, modules = [mod('entry', true), mod('a'), mod('b')]) => ({ entry: 'entry', modules, edges });
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
}

test('diffs kind, targets, externals, delimiters and Unicode in code-unit order', t => {
  const { put } = fixture(t);
  const baseEdges = [edge('entry', 'same', 'lazy', 'a'), edge('entry', 'kind', 'eager', null), edge('entry', 'target', 'lazy', 'a'), edge('entry', 'external', 'lazy', null), edge('entry', 'a|b', 'lazy', 'a'), edge('entry', '\u00e9', 'lazy', null)];
  const currentEdges = [edge('entry', 'target', 'lazy', 'b'), edge('entry', 'kind', 'lazy', null), edge('entry', 'same', 'lazy', 'a'), edge('entry', 'external', 'lazy', 'a'), edge('entry', 'a', 'lazy', 'b'), edge('entry', 'z', 'lazy', null)];
  const base = put('base.json', report(baseEdges)), current = put('current.json', report(currentEdges));
  const before = readFileSync(base, 'utf8'), after = readFileSync(current, 'utf8');
  const expected = { entry: 'entry', added: [edge('entry', 'a', 'lazy', 'b'), edge('entry', 'external', 'lazy', 'a'), edge('entry', 'kind', 'lazy', null), edge('entry', 'target', 'lazy', 'b'), edge('entry', 'z', 'lazy', null)], removed: [edge('entry', 'a|b', 'lazy', 'a'), edge('entry', 'external', 'lazy', null), edge('entry', 'kind', 'eager', null), edge('entry', 'target', 'lazy', 'a'), edge('entry', '\u00e9', 'lazy', null)] };
  success(run(cli, base, current), expected);
  const reordered = put('reordered.json', report([...currentEdges].reverse(), [mod('b'), mod('a'), mod('entry', true)]));
  success(run(cli, base, reordered), expected);
  success(run(cli, current, reordered), { entry: 'entry', added: [], removed: [] });
  assert.equal(readFileSync(base, 'utf8'), before); assert.equal(readFileSync(current, 'utf8'), after);
});

test('sorts tuple fields including null before strings and prevents delimiter collisions', t => {
  const { put } = fixture(t);
  const modules = [mod('entry', true), mod('a|b'), mod('a'), mod('b')];
  const edges = [edge('entry', 's', 'lazy', 'b'), edge('entry', 's', 'lazy', null), edge('entry', 's', 'lazy', 'a'), edge('a|b', 'c', 'lazy', null), edge('a', 'b|c', 'lazy', null)];
  const base = put('base', report([], modules)); const current = put('current', report(edges, modules));
  success(run(cli, base, current), { entry: 'entry', added: [edge('a', 'b|c', 'lazy', null), edge('a|b', 'c', 'lazy', null), edge('entry', 's', 'lazy', null), edge('entry', 's', 'lazy', 'a'), edge('entry', 's', 'lazy', 'b')], removed: [] });
});

test('rejects bad arguments, shape, graph and duplicate tuples without partial output', t => {
  const { put, dir } = fixture(t); const good = report([]); const base = put('base', good);
  const cases = [
    [null, 'invalid report'], [[], 'invalid report'], [{}, 'invalid report'],
    [{ ...good, entry: '' }, 'invalid report'], [{ ...good, modules: [] }, 'invalid report'],
    [{ ...good, modules: [mod('entry', true), mod('entry')] }, 'duplicate module'],
    [{ ...good, modules: [mod('entry', false)] }, 'invalid eager closure'],
    [{ ...good, modules: [{ path: 'entry', bytes: -1, eager: true }] }, 'invalid module'],
    [{ ...good, edges: [edge('missing', '', 'lazy', null)] }, 'dangling edge'],
    [{ ...good, edges: [edge('entry', '', 'lazy', 'missing')] }, 'dangling edge'],
    [{ ...good, edges: [edge('entry', '', 'wrong', null)] }, 'invalid edge'],
    [{ ...good, edges: [edge('entry', '', 'lazy', null), edge('entry', '', 'lazy', null)] }, 'duplicate edge'],
    [{ ...good, edges: [edge('entry', '', 'eager', 'a')] }, 'invalid eager closure'],
    [{ ...good, entry: 'a', modules: [mod('a', true)] }, 'entry mismatch'],
    [{ ...good, entry: 'missing' }, 'dangling entry'],
  ];
  for (const [i, [value, category]] of cases.entries()) {
    const path = put(`bad${i}`, JSON.stringify(value));
    for (const args of [[base, path], [path, base]]) {
      const result = run(cli, ...args); assert.equal(result.status, 1, `case ${i}`); assert.equal(result.stdout, ''); assert.equal(result.stderr, `${category}\n`, `case ${i}`);
    }
  }
  const argumentCases = [
    [[], 'invalid arguments'], [[base], 'invalid arguments'], [[base, base, base], 'invalid arguments'],
    [[base, put('broken', '{')], 'invalid json or file'], [[base, join(dir, 'missing')], 'invalid json or file'],
  ];
  for (const [args, category] of argumentCases) {
    const result = run(cli, ...args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, `${category}\n`);
  }
});

test('compares real static scanner reports without executing source', t => {
  const { put } = fixture(t);
  const entry = put('entry.mjs', "import './child.mjs';\nthrow Error('must not run');\n"); put('child.mjs', 'export default 1;\n');
  const first = run(scanner, entry); assert.equal(first.status, 0, first.stderr);
  put('entry.mjs', "import('./child.mjs');\nthrow Error('must not run');\n");
  const second = run(scanner, entry); assert.equal(second.status, 0, second.stderr);
  success(run(cli, put('first.json', first.stdout), put('second.json', second.stdout)), { entry: 'entry.mjs', added: [edge('entry.mjs', './child.mjs', 'lazy', 'child.mjs')], removed: [edge('entry.mjs', './child.mjs', 'eager', 'child.mjs')] });
});
