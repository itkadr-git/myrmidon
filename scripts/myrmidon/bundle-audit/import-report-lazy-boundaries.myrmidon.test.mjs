import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-lazy-boundaries.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
const mod = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const fixture = { entry: 'e', modules: [mod('e', 1, true), mod('a', 2, true), mod('b', 3, true), mod('lazy', 4, false), mod('zero', 0, false), mod('deep', 7, false)], edges: [edge('e', 'a', 'eager', 'a'), edge('a', 'b', 'eager', 'b'), edge('b', 'e', 'eager', 'e'), edge('e', 'alternate', 'lazy', 'b'), edge('e', 'self', 'lazy', 'e'), edge('e', 'unknown', 'lazy', null), edge('lazy', 'deep', 'lazy', 'deep'), edge('e', 'z', 'lazy', 'lazy'), edge('e', 'A', 'lazy', 'lazy'), edge('a', 'zero', 'lazy', 'zero')] };
const expected = { entry: 'e', boundaries: [{ from: 'a', specifier: 'zero', to: 'zero', bytes: 0 }, { from: 'e', specifier: 'A', to: 'lazy', bytes: 4 }, { from: 'e', specifier: 'z', to: 'lazy', bytes: 4 }] };
function scratch(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'lazy-boundaries-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function check(path, output) {
  const before = readFileSync(path, 'utf8');
  const result = run([path]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(output)}\n`);
  assert.equal(readFileSync(path, 'utf8'), before);
}
test('startup boundaries exclude alternate eager paths and lazy sources', t => {
  const dir = scratch(t), path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(fixture));
  check(path, expected);
  writeFileSync(path, JSON.stringify({ ...fixture, modules: [...fixture.modules].reverse(), edges: [...fixture.edges].reverse(), counts: 'ignored' }));
  check(path, expected);
});
test('boundary bytes include the lazy-only eager closure once', t => {
  const dir = scratch(t), path = join(dir, 'report.json');
  const report = {
    entry: 'entry',
    modules: [mod('entry', 100, true), mod('shared', 50, true), mod('intermediate', 3, false), mod('left', 2, false), mod('right', 5, false), mod('target', 7, false), mod('nested', 11, false)],
    edges: [edge('entry', 'shared', 'eager', 'shared'), edge('entry', 'load', 'lazy', 'intermediate'), edge('intermediate', 'left', 'eager', 'left'), edge('intermediate', 'right', 'eager', 'right'), edge('left', 'target', 'eager', 'target'), edge('right', 'target', 'eager', 'target'), edge('target', 'left', 'eager', 'left'), edge('target', 'shared', 'eager', 'shared'), edge('intermediate', 'nested', 'lazy', 'nested')],
  };
  writeFileSync(path, JSON.stringify(report));
  check(path, { entry: 'entry', boundaries: [{ from: 'entry', specifier: 'load', to: 'intermediate', bytes: 17 }] });
});
test('invalid argv, file, JSON, shape and graph fail closed', t => {
  const dir = scratch(t), path = join(dir, 'report.json');
  for (const args of [[], [path, 'extra']]) {
    const r = run(args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'argv\n');
  }
  const missing = run([join(dir, 'secret')]);
  assert.equal(missing.status, 1); assert.equal(missing.stdout, ''); assert.equal(missing.stderr, 'file\n');
  const cases = [
    ['json', '{secret'], ['shape', '{}'],
    ['shape', JSON.stringify({ ...fixture, modules: [mod('e', -1, true)] })],
    ['shape', JSON.stringify({ ...fixture, edges: [edge('e', 'x', 'lazy', '')] })],
    ['graph', JSON.stringify({ ...fixture, modules: [...fixture.modules, fixture.modules[0]] })],
    ['graph', JSON.stringify({ ...fixture, edges: [...fixture.edges, fixture.edges[0]] })],
    ['graph', JSON.stringify({ ...fixture, edges: [...fixture.edges, edge('e', 'x', 'lazy', 'missing')] })],
    ['graph', JSON.stringify({ ...fixture, edges: [...fixture.edges, edge('missing', 'x', 'lazy', null)] })],
    ['graph', JSON.stringify({ ...fixture, modules: fixture.modules.map(m => m.path === 'b' ? { ...m, eager: false } : m) })],
    ['graph', JSON.stringify({ ...fixture, modules: fixture.modules.map(m => m.path === 'lazy' ? { ...m, eager: true } : m) })],
  ];
  for (const [category, input] of cases) {
    writeFileSync(path, input); const r = run([path]);
    assert.equal(r.status, 1, category); assert.equal(r.stdout, '', category); assert.equal(r.stderr, `${category}\n`);
    assert.equal(readFileSync(path, 'utf8'), input);
  }
});
test('real scanner report identifies only lazy-only target', t => {
  const dir = scratch(t), path = join(dir, 'report.json');
  writeFileSync(join(dir, 'entry.mjs'), "import './a.mjs'; import('./a.mjs'); import('./lazy.mjs');\n");
  writeFileSync(join(dir, 'a.mjs'), 'export default 1;\n');
  writeFileSync(join(dir, 'lazy.mjs'), 'export default 2;\n');
  const scan = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(scan.status, 0, scan.stderr); writeFileSync(path, scan.stdout);
  check(path, { entry: 'entry.mjs', boundaries: [{ from: 'entry.mjs', specifier: './lazy.mjs', to: 'lazy.mjs', bytes: 18 }] });
});
