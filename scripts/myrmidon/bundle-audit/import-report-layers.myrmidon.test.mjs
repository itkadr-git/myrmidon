import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-layers.mjs', import.meta.url).pathname;
const scanner = new URL('./import-budget.mjs', import.meta.url).pathname;
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unknown') => ({ from, to, kind, specifier });
const check = (report, expected) => {
  const input = JSON.stringify(report);
  const result = run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  assert.equal(run(input).stdout, result.stdout);
  assert.equal(run(JSON.stringify({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() })).stdout, result.stdout);
};

test('single entry and linear graph have exact layers', () => {
  check({ entry: 'e', modules: [moduleOf('e', 0)], edges: [] }, { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 0 }], unreachable: [] });
  check({ entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3)], edges: [edge('e', 'a'), edge('a', 'b')] }, { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a'], bytes: 2 }, { depth: 2, paths: ['b'], bytes: 3 }], unreachable: [] });
});

test('shortest eager paths ignore lazy shortcut, cycles, unknowns and disconnected nodes', () => {
  const report = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 3), moduleOf('c', 4), moduleOf('z', 0), moduleOf('é', 5), moduleOf('lazy', 8, false), moduleOf('disconnected', 9, false)], edges: [edge('e', 'a'), edge('a', 'b'), edge('b', 'c'), edge('e', 'z'), edge('z', 'c'), edge('e', 'c', 'lazy'), edge('e', 'lazy', 'lazy'), edge('c', 'e'), edge('c', 'c'), edge('e', null), edge('e', 'é')] };
  check(report, { entry: 'e', layers: [{ depth: 0, paths: ['e'], bytes: 1 }, { depth: 1, paths: ['a', 'z', 'é'], bytes: 7 }, { depth: 2, paths: ['b', 'c'], bytes: 7 }], unreachable: ['disconnected', 'lazy'] });
});

test('invalid arguments, JSON, shape and graph fail without leaking input', () => {
  const valid = { entry: 'secret-entry', modules: [moduleOf('secret-entry', 1), moduleOf('x', 2, false)], edges: [] };
  const cases = [
    ['argv', JSON.stringify(valid), ['secret-arg']], ['json', '{secret', []],
    ['shape', '{}', []], ['shape', JSON.stringify({ ...valid, modules: [moduleOf('secret-entry', -1)] }), []],
    ['shape', JSON.stringify({ ...valid, edges: [edge('secret-entry', '', 'eager')] }), []],
    ['graph', JSON.stringify({ ...valid, modules: [moduleOf('secret-entry', 1), moduleOf('secret-entry', 2)] }), []],
    ['graph', JSON.stringify({ ...valid, edges: [edge('secret-entry', 'x'), edge('secret-entry', 'x')] }), []],
    ['graph', JSON.stringify({ ...valid, edges: [edge('secret-entry', 'missing')] }), []],
    ['graph', JSON.stringify({ ...valid, modules: [moduleOf('secret-entry', 1, false)] }), []],
    ['graph', JSON.stringify({ entry: 'e', modules: [moduleOf('e', 0), moduleOf('a', Number.MAX_SAFE_INTEGER), moduleOf('b', 1)], edges: [edge('e', 'a'), edge('e', 'b')] }), []],
  ];
  for (const [category, input, args] of cases) {
    const result = run(input, args);
    assert.equal(result.status, 1, category);
    assert.equal(result.stdout, '', category);
    assert.equal(result.stderr, `${category}\n`);
  }
});

test('real scanner report keeps dynamic shortcut out of eager depth', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'layers-'));
  try {
    const entry = "import './a.mjs'; import('./b.mjs');\n";
    const a = "import './b.mjs';\n";
    const b = 'export default 1;\n';
    writeFileSync(join(dir, 'entry.mjs'), entry);
    writeFileSync(join(dir, 'a.mjs'), a);
    writeFileSync(join(dir, 'b.mjs'), b);
    const result = spawnSync(process.execPath, [scanner, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    check(JSON.parse(result.stdout), { entry: 'entry.mjs', layers: [{ depth: 0, paths: ['entry.mjs'], bytes: 37 }, { depth: 1, paths: ['a.mjs'], bytes: 18 }, { depth: 2, paths: ['b.mjs'], bytes: 18 }], unreachable: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
