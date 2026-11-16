import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const spawn = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'lazy-impact-'));
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

test('errors have stable category, no stdout or input leakage', t => {
  const dir = fixture(t), base = diamond();
  const invalid = [null, {}, { ...base, entry: 'missing' }, { ...base, modules: [...base.modules, base.modules[0]] }, { ...base, modules: base.modules.map((m, i) => i ? m : { ...m, bytes: -1 }) }, { ...base, modules: base.modules.map((m, i) => i ? m : { ...m, eager: false }) }, { ...base, edges: [...base.edges, base.edges[0]] }, { ...base, edges: [...base.edges, edge('missing', 'x', 'a')] }, { ...base, edges: [...base.edges, edge('entry', 'a', 'b')] }, { ...base, edges: [...base.edges, edge('entry', 'x', 'missing')] }, { ...base, edges: [...base.edges, edge('entry', 'x', null, 'bad')] }];
  for (const report of invalid) {
    const r = runReport(dir, report);
    assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /^error: (shape|graph|selection)\n$/);
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(base));
  for (const args of [[], [join(dir, 'missing'), 'a', 'b'], [join(dir, 'report.json'), 'entry', 'lazy']]) {
    const r = spawn(cli, args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /^error: (argv|read|selection)\n$/);
  }
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{');
  const r = spawn(cli, [bad, 'entry', 'a']); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'error: json\n');
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
