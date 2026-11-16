import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
const mod = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });
const fixture = t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-impact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const check = (dir, report, target, expected) => {
  const file = join(dir, 'report.json'), input = JSON.stringify(report);
  writeFileSync(file, input);
  for (const value of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    writeFileSync(file, JSON.stringify(value));
    const before = readFileSync(file, 'utf8'), result = run(file, target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  writeFileSync(file, input);
};

test('chain includes transitive importers at distance three', t => {
  const report = { entry: 'e', modules: ['e', 'a', 'b', 'target'].map(x => mod(x)), edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'target')] };
  check(fixture(t), report, 'target', { entry: 'e', target: 'target', importers: [{ path: 'b', distance: 1 }, { path: 'a', distance: 2 }, { path: 'e', distance: 3 }] });
});

test('shortest distances, cycles, lazy-only components and code-unit ordering', t => {
  const report = { entry: 'e', modules: ['e', 'a', 'b', 'z', 'target'].map(x => mod(x)).concat([mod('lazy', false), mod('other', false), mod('\u00e9', false)]), edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'target'), edge('e', 'z'), edge('z', 'target'), edge('target', 'a'), edge('target', 'target'), edge('e', 'target', 'lazy'), edge('e', 'lazy', 'lazy'), edge('lazy', 'target'), edge('other', 'lazy'), edge('\u00e9', 'target'), edge('e', null)] };
  check(fixture(t), report, 'target', { entry: 'e', target: 'target', importers: [{ path: 'b', distance: 1 }, { path: 'lazy', distance: 1 }, { path: 'z', distance: 1 }, { path: '\u00e9', distance: 1 }, { path: 'a', distance: 2 }, { path: 'e', distance: 2 }, { path: 'other', distance: 2 }] });
});

test('invalid input fails closed by category', t => {
  const dir = fixture(t), file = join(dir, 'report.json');
  const valid = { entry: 'e', modules: [mod('e'), mod('x', false)], edges: [] };
  const cases = [
    ['argv', null, []], ['argv', null, [file, 'e', 'extra']], ['file', null, [join(dir, 'secret'), 'e']],
    ['json', '{secret', [file, 'e']], ['shape', '{}', [file, 'e']],
    ['shape', JSON.stringify({ ...valid, modules: [mod('e'), { ...mod('x'), bytes: -1 }] }), [file, 'e']],
    ['shape', JSON.stringify({ ...valid, edges: [edge('e', '')] }), [file, 'e']],
    ['graph', JSON.stringify(valid), [file, 'missing']],
    ['graph', JSON.stringify({ ...valid, modules: [mod('e'), mod('e')] }), [file, 'e']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('e', 'x'), edge('e', 'x')] }), [file, 'e']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('e', 'missing')] }), [file, 'e']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('missing', 'e')] }), [file, 'e']],
    ['graph', JSON.stringify({ ...valid, modules: [mod('e', false), mod('x', false)] }), [file, 'e']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('e', 'x')] }), [file, 'e']],
  ];
  for (const [category, input, args] of cases) {
    if (input !== null) writeFileSync(file, input);
    const result = run(...args);
    assert.equal(result.status, 1, category);
    assert.equal(result.stdout, '', category);
    assert.equal(result.stderr, `${category}\n`);
  }
});

test('real import-budget report on synthetic modules', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'entry.mjs'), "import './a.mjs'; import('./b.mjs');\n");
  writeFileSync(join(dir, 'a.mjs'), "import './b.mjs';\n");
  writeFileSync(join(dir, 'b.mjs'), 'export default 1;\n');
  const result = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  check(dir, JSON.parse(result.stdout), 'b.mjs', { entry: 'entry.mjs', target: 'b.mjs', importers: [{ path: 'a.mjs', distance: 1 }, { path: 'entry.mjs', distance: 2 }] });
});
