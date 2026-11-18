import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-compare.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
const report = modules => ({ entry: 'entry.mjs', modules, counts: { modules: modules.length, eagerModules: modules.filter(m => m.eager).length }, bytes: { total: modules.reduce((n, m) => n + m.bytes, 0), eager: modules.filter(m => m.eager).reduce((n, m) => n + m.bytes, 0) } });
const mod = (path, bytes, eager) => ({ path, bytes, eager });
function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.cwd(), 'report-compare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, value) => { const path = join(dir, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
  return { dir, put };
}

test('compares additions, removals, renames, byte and eager changes deterministically', t => {
  const { put } = fixture(t);
  const base = put('base.json', report([mod('z', 4, false), mod('old', 2, true), mod('eager', 3, false), mod('bytes', 5, true)]));
  const current = put('current.json', report([mod('new', 2, true), mod('bytes', 8, true), mod('eager', 3, true), mod('a', 1, false)]));
  const before = readFileSync(base, 'utf8'), now = readFileSync(current, 'utf8');
  const result = run(cli, base, current);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 1, totalBytes: 0, eagerBytes: 6 }, added: [mod('a', 1, false), mod('new', 2, true)], removed: [mod('old', 2, true), mod('z', 4, false)], changed: [{ path: 'bytes', before: { bytes: 5, eager: true }, after: { bytes: 8, eager: true } }, { path: 'eager', before: { bytes: 3, eager: false }, after: { bytes: 3, eager: true } }] });
  assert.equal(run(cli, base, current).stdout, result.stdout);
  assert.equal(readFileSync(base, 'utf8'), before); assert.equal(readFileSync(current, 'utf8'), now);
  const reordered = put('reordered.json', report([mod('bytes', 5, true), mod('eager', 3, false), mod('old', 2, true), mod('z', 4, false)]));
  assert.deepEqual(JSON.parse(run(cli, base, reordered).stdout), { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 0, totalBytes: 0, eagerBytes: 0 }, added: [], removed: [], changed: [] });
});

test('reverse comparison returns negative deltas for counts and bytes', t => {
  const { put } = fixture(t);
  const smaller = put('small.json', report([mod('shared', 2, true)]));
  const larger = put('large.json', report([mod('shared', 5, true), mod('extra', 7, true), mod('lazy', 3, false)]));
  const result = run(cli, larger, smaller);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    entry: 'entry.mjs',
    delta: { modules: -2, eagerModules: -1, totalBytes: -13, eagerBytes: -10 },
    added: [],
    removed: [mod('extra', 7, true), mod('lazy', 3, false)],
    changed: [{ path: 'shared', before: { bytes: 5, eager: true }, after: { bytes: 2, eager: true } }],
  });
});

test('accepts maximum safe integer totals and negative byte delta', t => {
  const { put } = fixture(t);
  const base = put('max.json', report([mod('large', Number.MAX_SAFE_INTEGER, true)]));
  const current = put('zero.json', report([mod('large', 0, true)]));
  const result = run(cli, base, current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    entry: 'entry.mjs',
    delta: { modules: 0, eagerModules: 0, totalBytes: -9007199254740991, eagerBytes: -9007199254740991 },
    added: [], removed: [],
    changed: [{ path: 'large', before: { bytes: 9007199254740991, eager: true }, after: { bytes: 0, eager: true } }],
  });
});

test('rejects malformed reports without disclosing paths', t => {
  const { put } = fixture(t); const good = report([mod('entry.mjs', 1, true)]); const base = put('base.json', good);
  const badReports = [null, {}, { ...good, entry: 'other' }, { ...good, modules: [mod('x', 1, true), mod('x', 1, true)] }, { ...good, modules: [mod('x', -1, true)] }, { ...good, modules: [mod('x', 1.5, true)] }, { ...good, modules: [mod('x', 1, 'yes')] }, { ...good, counts: { ...good.counts, modules: 2 } }, { ...good, bytes: { ...good.bytes, eager: 0 } }, { ...good, modules: [mod('x', Number.MAX_SAFE_INTEGER, true), mod('y', 1, false)] }];
  for (const [i, value] of badReports.entries()) {
    const path = put(`bad${i}.json`, JSON.stringify(value)); const result = run(cli, base, path);
    assert.equal(result.status, 1, `case ${i}: ${result.stderr}`); assert.equal(result.stdout, ''); assert.match(result.stderr, /^[a-z ]+\n$/); assert.ok(!result.stderr.includes(path));
  }
  for (const args of [[], [base], [base, base, base], [base, put('invalid.json', '{')], [base, join('/nonexistent', 'secret')]]) {
    const result = run(cli, ...args); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^[a-z ]+\n$/);
  }
});

test('compares real scanner reports without executing fixture source', t => {
  const { dir, put } = fixture(t);
  const entry = put('entry.mjs', "import './child.mjs';\nthrow new Error('must not execute');\n");
  put('child.mjs', 'export default 1;\n');
  const first = run(scanner, entry); assert.equal(first.status, 0, first.stderr);
  put('child.mjs', 'export default 12345;\n');
  const second = run(scanner, entry); assert.equal(second.status, 0, second.stderr);
  const result = run(cli, put('one.json', first.stdout), put('two.json', second.stdout));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 0, totalBytes: 4, eagerBytes: 4 }, added: [], removed: [], changed: [{ path: 'child.mjs', before: { bytes: 18, eager: true }, after: { bytes: 22, eager: true } }] });
});
