import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-cycles.mjs');
const budget = join(dir, 'import-budget.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, '.cache');
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
const moduleFor = path => ({ path, bytes: 0, eager: false });
const edge = (from, to, kind = 'eager', specifier = to || 'unknown') => ({ from, to, kind, specifier });
function fixture(t) { const d = mkdtempSync(join(root, 'cycles-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
function check(t, report, expected) {
  const file = join(fixture(t), 'report.json'); const input = JSON.stringify(report); writeFileSync(file, input);
  const result = run(cli, file);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n'); assert.equal(readFileSync(file, 'utf8'), input);
}

test('self-loop is a cycle', t => {
  check(t, { entry: 'a', modules: [moduleFor('a')], edges: [edge('a', 'a')] }, { entry: 'a', eagerCycles: [['a']], allCycles: [['a']] });
});

test('distinguishes lazy closures and disconnected cycles with stable code-unit order', t => {
  const report = { entry: 'z', extra: true, modules: ['z', 'b', 'a', 'Z', 'q', 'p', 'd', 'c'].map(moduleFor), edges: [
    edge('z', 'a'), edge('a', 'z', 'lazy'), edge('z', 'a', 'lazy'), edge('b', 'Z'), edge('Z', 'b'),
    edge('p', 'q'), edge('q', 'p'), edge('a', null), edge('c', 'd'),
  ] };
  const expected = { entry: 'z', eagerCycles: [['Z', 'b'], ['p', 'q']], allCycles: [['Z', 'b'], ['a', 'z'], ['p', 'q']] };
  check(t, report, expected);
  report.modules.reverse(); report.edges.reverse(); check(t, report, expected);
});

test('diamond DAG is not a cycle', t => {
  check(t, { entry: 'a', modules: ['a', 'b', 'c', 'd'].map(moduleFor), edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')] }, { entry: 'a', eagerCycles: [], allCycles: [] });
});

test('rejects malformed reports and graph references without leaking input', t => {
  const d = fixture(t), file = join(d, 'secret-report.json');
  const fail = (result, category) => { assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, `FAIL: ${category}\n`); };
  fail(run(cli), 'arguments'); fail(run(cli, file, 'extra'), 'arguments'); fail(run(cli, file), 'read');
  writeFileSync(file, 'secret invalid json'); fail(run(cli, file), 'json');
  const base = () => ({ entry: 'a', modules: [moduleFor('a'), moduleFor('b')], edges: [edge('a', 'b')] });
  const cases = [
    [null, 'shape'], [[], 'shape'], [{ entry: 5, modules: [], edges: [] }, 'shape'],
    ...[r => r.modules = {}, r => r.edges = null, r => r.modules[0].path = '', r => r.modules[0].bytes = -1,
      r => r.modules[0].bytes = 1.2, r => r.modules[0].bytes = Number.MAX_SAFE_INTEGER + 1,
      r => r.modules[0].eager = 1, r => r.edges[0].from = '', r => r.edges[0].specifier = '',
      r => r.edges[0].kind = 'other', r => r.edges[0].to = '', r => r.edges[0].to = 4].map(mutate => { const r = base(); mutate(r); return [r, 'shape']; }),
    ...[r => r.entry = 'secret', r => r.edges[0].from = 'secret', r => r.edges[0].to = 'secret'].map(mutate => { const r = base(); mutate(r); return [r, 'reference']; }),
    ...[r => r.modules.push({ ...r.modules[0] }), r => r.edges.push({ ...r.edges[0] })].map(mutate => { const r = base(); mutate(r); return [r, 'duplicate']; }),
  ];
  for (const [value, category] of cases) { writeFileSync(file, JSON.stringify(value)); fail(run(cli, file), category); }
});

test('consumes an actual import-budget report without executing sources', t => {
  const d = fixture(t), a = join(d, 'entry.mjs'), b = join(d, 'lazy.mjs');
  const sourceA = "import('./lazy.mjs');\nthrow new Error('must not execute');\n";
  const sourceB = "import './entry.mjs';\n";
  writeFileSync(a, sourceA); writeFileSync(b, sourceB);
  const scan = run(budget, a); assert.equal(scan.status, 0, scan.stderr); assert.equal(scan.stderr, '');
  const report = join(d, 'report.json'); writeFileSync(report, scan.stdout);
  const output = run(cli, report); assert.equal(output.status, 0, output.stderr); assert.equal(output.stderr, '');
  assert.equal(output.stdout, JSON.stringify({ entry: 'entry.mjs', eagerCycles: [], allCycles: [['entry.mjs', 'lazy.mjs']] }) + '\n');
  assert.equal(readFileSync(a, 'utf8'), sourceA); assert.equal(readFileSync(b, 'utf8'), sourceB); assert.equal(readFileSync(report, 'utf8'), scan.stdout);
});
