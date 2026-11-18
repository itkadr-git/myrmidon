import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const spawn = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'lazy-impact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mod = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, specifier, to, kind = 'eager') => ({ from, specifier, to, kind });
const diamond = () => ({ entry: 'entry', modules: [mod('entry', 10), mod('a', 20), mod('b', 30), mod('shared', 0), mod('z', 7), mod('lazy', 4, false)], edges: [edge('entry', 'a', 'a'), edge('entry', 'b', 'b'), edge('a', 'shared', 'shared'), edge('b', 'shared', 'shared'), edge('a', 'z', 'z'), edge('z', 'a', 'a'), edge('entry', 'lazy', 'lazy', 'lazy')] });
function runReport(dir, report, from = 'entry', specifier = 'a') {
  const file = join(dir, 'report.json');
  const text = JSON.stringify(report);
  writeFileSync(file, text);
  const result = spawn(cli, [file, from, specifier]);
  assert.equal(readFileSync(file, 'utf8'), text);
  return result;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
const expected = { entry: 'entry', selected: { from: 'entry', specifier: 'a', to: 'a' }, before: { modules: 5, bytes: 67 }, after: { modules: 3, bytes: 40 }, removedPaths: ['a', 'z'], savedBytes: 27 };

test('diamond retains shared dependency, handles cycle, and is order independent without input mutation', t => {
  const dir = fixture(t), report = diamond();
  success(runReport(dir, report), expected);
  report.modules.reverse(); report.edges.reverse();
  success(runReport(dir, report), expected);
});

test('alternate direct path yields zero effect and zero-byte modules count', t => {
  const dir = fixture(t), report = diamond();
  report.edges.push(edge('entry', 'other', 'a'));
  success(runReport(dir, report), { ...expected, after: { modules: 5, bytes: 67 }, removedPaths: [], savedBytes: 0 });
});

test('errors have exact categories, no stdout or input leakage', t => {
  const dir = fixture(t), base = diamond();
  const withModule = changes => ({ ...base, modules: base.modules.map((m, i) => i ? m : { ...m, ...changes }) });
  const withEdge = item => ({ ...base, edges: [...base.edges, item] });
  const cases = [
    ['null report', null, 'shape'], ['missing fields', {}, 'shape'],
    ['missing entry', { ...base, entry: 'missing' }, 'graph'],
    ['duplicate module', { ...base, modules: [...base.modules, base.modules[0]] }, 'graph'],
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '10'].map(bytes => [`bytes ${bytes}`, withModule({ bytes }), 'shape']),
    ['empty path', withModule({ path: '' }), 'shape'],
    ['non-boolean eager', withModule({ eager: 'true' }), 'shape'],
    ['inconsistent eager', withModule({ eager: false }), 'graph'],
    ['duplicate edge', withEdge(base.edges[0]), 'graph'],
    ['missing from', withEdge(edge('missing', 'x', 'a')), 'graph'],
    ['ambiguous selection', withEdge(edge('entry', 'a', 'b')), 'selection'],
    ['missing to', withEdge(edge('entry', 'x', 'missing')), 'graph'],
    ['bad kind', withEdge(edge('entry', 'x', null, 'bad')), 'shape'],
    ['empty from', withEdge(edge('', 'x', 'a')), 'shape'],
    ['empty specifier', withEdge(edge('entry', '', 'a')), 'shape'],
    ['invalid to', withEdge(edge('entry', 'x', 42)), 'shape'],
  ];
  const failure = (result, category, label) => {
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, '', label);
    assert.equal(result.stderr, `error: ${category}\n`, label);
  };
  for (const [label, report, category] of cases) failure(runReport(dir, report), category, label);
  const reportFile = join(dir, 'report.json');
  writeFileSync(reportFile, JSON.stringify(base));
  for (const [args, category] of [
    [[], 'argv'], [[reportFile, '', 'a'], 'argv'],
    [[join(dir, 'missing'), 'a', 'b'], 'read'],
    [[reportFile, 'entry', 'lazy'], 'selection'],
    [[reportFile, 'entry', 'absent'], 'selection'],
  ]) failure(spawn(cli, args), category, JSON.stringify(args));
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{');
  failure(spawn(cli, [bad, 'entry', 'a']), 'json', 'invalid JSON');
  assert.equal(readFileSync(reportFile, 'utf8'), JSON.stringify(base));
});

test('accepts unresolved edges and additional fields without changing input', t => {
  const dir = fixture(t), report = diamond();
  report.extra = { ignored: true };
  report.modules[0].extra = 'ignored';
  report.edges.push({ ...edge('entry', 'unknown', null), extra: true });
  success(runReport(dir, report), expected);
  const result = runReport(dir, report, 'entry', 'unknown');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: selection\n');
});

test('accepts a real scanner report and never executes source', t => {
  const dir = fixture(t), entry = join(dir, 'entry.mjs');
  const source = "import './child.mjs';\nthrow new Error('must not execute');\n";
  const child = 'export default 1;\n';
  writeFileSync(entry, source); writeFileSync(join(dir, 'child.mjs'), child);
  const scanned = spawn(scanner, [entry]); assert.equal(scanned.status, 0, scanned.stderr);
  const report = JSON.parse(scanned.stdout);
  success(runReport(dir, report, 'entry.mjs', './child.mjs'), { entry: 'entry.mjs', selected: { from: 'entry.mjs', specifier: './child.mjs', to: 'child.mjs' }, before: { modules: 2, bytes: Buffer.byteLength(source) + Buffer.byteLength(child) }, after: { modules: 1, bytes: Buffer.byteLength(source) }, removedPaths: ['child.mjs'], savedBytes: Buffer.byteLength(child) });
  assert.equal(readFileSync(entry, 'utf8'), source);
});
