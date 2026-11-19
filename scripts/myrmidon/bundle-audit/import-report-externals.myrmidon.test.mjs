import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const run = (program, args) => spawnSync(process.execPath, [program, ...args], { encoding: 'utf8', timeout: 10000 });
const fixture = t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'external-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const moduleRecord = path => ({ path, bytes: 0, eager: true });
const edge = (from, specifier, kind = 'eager', to = null) => ({ from, specifier, kind, to });
const base = () => ({ entry: 'entry', modules: ['entry', 'Z', 'a'].map(moduleRecord), edges: [] });
const save = (dir, value) => { const path = join(dir, 'report.json'); writeFileSync(path, JSON.stringify(value)); return path; };

test('groups exact specifiers and importer kinds deterministically without changing input', t => {
  const dir = fixture(t), report = base();
  report.edges = [edge('a', '@scope/pkg/sub', 'lazy'), edge('Z', '@scope/pkg/sub'), edge('a', '@scope/pkg/sub'), edge('entry', '@scope/pkg'), edge('entry', 'pkg'), edge('entry', 'pkg/sub', 'lazy'), edge('entry', './missing'), edge('entry', '/absolute'), edge('entry', 'C:\\missing', 'lazy'), edge('entry', '../missing'), edge('entry', 'resolved', 'eager', 'a')];
  report.unknown = [edge('entry', 'ignored')];
  const expected = { entry: 'entry', externals: [
    { specifier: '@scope/pkg', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: '@scope/pkg/sub', eagerImporters: ['Z', 'a'], lazyImporters: ['a'] },
    { specifier: 'pkg', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['entry'] },
  ], unresolvedLocal: [
    { specifier: '../missing', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: './missing', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: '/absolute', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: 'C:\\missing', eagerImporters: [], lazyImporters: ['entry'] },
  ] };
  const path = save(dir, report), before = readFileSync(path, 'utf8');
  const result = run(cli, [path]);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.equal(readFileSync(path, 'utf8'), before);
  report.edges.reverse(); report.modules.reverse();
  assert.equal(run(cli, [save(dir, report)]).stdout, result.stdout);
});

test('empty report produces empty arrays', t => {
  const report = base();
  const result = run(cli, [save(fixture(t), report)]);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"entry":"entry","externals":[],"unresolvedLocal":[]}\n');
});

test('invalid input fails with stable categories and no partial output', t => {
  const dir = fixture(t), path = join(dir, 'bad.json');
  const check = (args, category) => { const r = run(cli, args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, category + '\n'); };
  check([], 'argv'); check([path, path], 'argv'); check([path], 'read');
  writeFileSync(path, '{'); check([path], 'json');
  const invalid = [null, [], {}, { ...base(), entry: 1 }, { ...base(), modules: [moduleRecord('entry'), moduleRecord('entry')] }, { ...base(), modules: [{ path: 'entry', bytes: -1, eager: true }] }, { ...base(), modules: [{ path: 'entry', bytes: Number.MAX_SAFE_INTEGER + 1, eager: true }] }, { ...base(), modules: [{ path: '', bytes: 0, eager: true }] }, { ...base(), modules: [{ path: 'entry', bytes: 0, eager: 1 }] }, { ...base(), edges: [edge('entry', '')] }, { ...base(), edges: [edge('entry', 'x', 'other')] }, { ...base(), edges: [{ ...edge('entry', 'x'), to: 1 }] }];
  for (const value of invalid) { save(dir, value); check([join(dir, 'report.json')], 'shape'); }
  const badGraph = [{ ...base(), entry: 'missing' }, { ...base(), edges: [edge('missing', 'x')] }, { ...base(), edges: [edge('entry', 'x', 'eager', 'missing')] }, { ...base(), edges: [edge('entry', 'x'), edge('entry', 'x')] }];
  for (const value of badGraph) { save(dir, value); check([join(dir, 'report.json')], 'graph'); }
});

test('accepts real scanner report without executing its source', t => {
  const dir = fixture(t), entry = join(dir, 'entry.mjs'), marker = join(dir, 'executed');
  writeFileSync(entry, `import 'pkg'; import('pkg/sub'); import './missing.mjs'; require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  const scan = run(scanner, [entry]); assert.equal(scan.status, 0, scan.stderr); assert.equal(existsSync(marker), false);
  const path = join(dir, 'scan.json'); writeFileSync(path, scan.stdout);
  const result = run(cli, [path]); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: 'entry.mjs', externals: [{ specifier: 'pkg', eagerImporters: ['entry.mjs'], lazyImporters: [] }, { specifier: 'pkg/sub', eagerImporters: [], lazyImporters: ['entry.mjs'] }], unresolvedLocal: [{ specifier: './missing.mjs', eagerImporters: ['entry.mjs'], lazyImporters: [] }] }) + '\n');
  assert.equal(readFileSync(path, 'utf8'), scan.stdout); assert.equal(existsSync(marker), false);
});
