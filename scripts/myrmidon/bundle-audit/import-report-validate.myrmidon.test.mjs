import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const cli = new URL('./import-report-validate.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 10000 });
const report = () => ({
  entry: 'entry.js',
  modules: [{ path: 'entry.js', bytes: 4, eager: true }, { path: 'lazy.js', bytes: 9, eager: false }],
  edges: [{ from: 'entry.js', specifier: './lazy.js', kind: 'lazy', to: 'lazy.js' }, { from: 'entry.js', specifier: 'pkg', kind: 'eager', to: null }],
  unknown: [{ from: 'entry.js', specifier: 'pkg', kind: 'eager', to: null }],
  counts: { modules: 2, eagerModules: 1, edges: 2 }, bytes: { total: 13, eager: 4 },
  heaviestEager: [{ path: 'entry.js', bytes: 4, eager: true }],
});
const pass = r => { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'PASS: import report\n'); assert.equal(r.stderr, ''); };
const fail = (r, category) => { assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, `FAIL: ${category}\n`); };

test('accepts a complete report deterministically and permits extra fields', () => {
  const value = report(); value.extra = { ignored: true }; value.modules[0].extra = 1;
  const input = JSON.stringify(value); pass(run(input)); pass(run(input));
});

test('rejects invalid JSON and arguments without echoing input', () => {
  fail(run('secret invalid JSON'), 'json');
  fail(run(JSON.stringify(report()), ['extra']), 'arguments');
});

test('rejects malformed shapes and numeric strings', () => {
  for (const mutate of [r => r.modules = [], r => r.entry = 2, r => r.edges = {}, r => r.unknown = null, r => r.heaviestEager = {}, r => r.modules[0].bytes = 'NaN', r => r.counts.edges = -1, r => r.bytes.total = 1.5, r => r.modules[0].eager = 'true', r => r.edges[0].kind = 'invalid']) {
    const r = report(); mutate(r); fail(run(JSON.stringify(r)), 'shape');
  }
});

test('rejects duplicate paths and edge tuples', () => {
  let r = report(); r.modules.push({ ...r.modules[0] }); fail(run(JSON.stringify(r)), 'duplicate');
  r = report(); r.modules.push({ path: 'entry.js', bytes: 999, eager: false }); fail(run(JSON.stringify(r)), 'duplicate');
  r = report(); r.edges.push({ ...r.edges[0] }); fail(run(JSON.stringify(r)), 'duplicate');
});

test('rejects dangling references and missing or lazy entry', () => {
  for (const mutate of [r => r.edges[0].to = 'missing', r => r.edges[0].from = 'missing', r => r.entry = 'missing', r => r.modules[0].eager = false]) {
    const r = report(); mutate(r); fail(run(JSON.stringify(r)), 'reference');
  }
});

test('rejects inconsistent counts, byte totals, unknown edges, and ranking', () => {
  for (const mutate of [r => r.counts.modules++, r => r.counts.eagerModules++, r => r.counts.edges++, r => r.bytes.total++, r => r.bytes.eager++, r => r.unknown = [], r => r.heaviestEager = [], r => r.heaviestEager[0].bytes++]) {
    const r = report(); mutate(r); fail(run(JSON.stringify(r)), 'inconsistent');
  }
});

test('checks top ten and path tie ordering', () => {
  const r = report();
  r.modules = Array.from({ length: 12 }, (_, i) => ({ path: `m${String(i).padStart(2, '0')}`, bytes: 1, eager: true }));
  r.entry = 'm00'; r.edges = []; r.unknown = []; r.counts = { modules: 12, eagerModules: 12, edges: 0 }; r.bytes = { total: 12, eager: 12 };
  r.heaviestEager = r.modules.slice(0, 10).map(m => ({ ...m })); pass(run(JSON.stringify(r)));
  [r.heaviestEager[0], r.heaviestEager[1]] = [r.heaviestEager[1], r.heaviestEager[0]]; fail(run(JSON.stringify(r)), 'inconsistent');
});

test('accepts a real scanner report without changing fixture files', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.cwd(), '.report-validate-'));
  try {
    const file = join(dir, 'entry.mjs'); const source = "import 'external-package';\n"; writeFileSync(file, source);
    const scan = spawnSync(process.execPath, [scanner, file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(scan.status, 0, scan.stderr); assert.equal(JSON.parse(scan.stdout).unknown.length, 1);
    pass(run(scan.stdout)); pass(run(scan.stdout)); assert.equal(readFileSync(file, 'utf8'), source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('rejects non-object roots and invalid numeric boundaries without echoing input', () => {
  for (const root of [null, []]) fail(run(JSON.stringify(root)), 'shape');
  for (const mutate of [
    r => r.modules[0].bytes = -1,
    r => r.modules[0].bytes = 1.5,
    r => r.modules[0].bytes = Number.MAX_SAFE_INTEGER + 1,
    r => r.counts.modules = Number.MAX_SAFE_INTEGER + 1,
    r => r.bytes.total = Number.MAX_SAFE_INTEGER + 1,
    r => r.counts.edges = 'NaN-secret',
    r => r.bytes.eager = 'Infinity-secret',
  ]) {
    const r = report(); mutate(r); fail(run(JSON.stringify(r)), 'shape');
  }
});

test('ranks the ten heaviest eager modules by bytes then path', () => {
  const r = report();
  r.modules = [
    { path: 'a', bytes: 2, eager: true }, { path: 'b', bytes: 9, eager: true },
    { path: 'c', bytes: 4, eager: true }, { path: 'd', bytes: 7, eager: true },
    { path: 'e', bytes: 8, eager: true }, { path: 'f', bytes: 3, eager: true },
    { path: 'g', bytes: 6, eager: true }, { path: 'h', bytes: 5, eager: true },
    { path: 'i', bytes: 1, eager: true }, { path: 'j', bytes: 10, eager: true },
    { path: 'k', bytes: 11, eager: true }, { path: 'l', bytes: 9, eager: true },
  ];
  r.entry = 'a'; r.edges = []; r.unknown = [];
  r.counts = { modules: 12, eagerModules: 12, edges: 0 }; r.bytes = { total: 75, eager: 75 };
  r.heaviestEager = [
    { path: 'k', bytes: 11, eager: true }, { path: 'j', bytes: 10, eager: true },
    { path: 'b', bytes: 9, eager: true }, { path: 'l', bytes: 9, eager: true },
    { path: 'e', bytes: 8, eager: true }, { path: 'd', bytes: 7, eager: true },
    { path: 'g', bytes: 6, eager: true }, { path: 'h', bytes: 5, eager: true },
    { path: 'c', bytes: 4, eager: true }, { path: 'f', bytes: 3, eager: true },
  ];
  pass(run(JSON.stringify(r)));
  const wrongOrder = structuredClone(r);
  [wrongOrder.heaviestEager[0], wrongOrder.heaviestEager[1]] = [wrongOrder.heaviestEager[1], wrongOrder.heaviestEager[0]];
  fail(run(JSON.stringify(wrongOrder)), 'inconsistent');
  const wrongCutoff = structuredClone(r);
  wrongCutoff.heaviestEager[9] = { path: 'a', bytes: 2, eager: true };
  fail(run(JSON.stringify(wrongCutoff)), 'inconsistent');
});
