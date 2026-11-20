import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const modules = eager => ['e', 'a', 'b', 't'].map((path, i) => ({ path, bytes: i + 1, eager: eager.includes(path) }));
const result = dominators => ({ entry: 'e', target: 't', dominators });

function run(root, report) {
  const path = join(root, 'report.json');
  const text = JSON.stringify(report);
  writeFileSync(path, text);
  const output = spawnSync(process.execPath, [cli, path, 't'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readFileSync(path, 'utf8'), text);
  return output;
}

function positive(root, report, expected) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const output = run(root, input);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, '');
    assert.equal(output.stdout, JSON.stringify(expected) + '\n');
  }
}

function withScratch(fn) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dom-removal-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function contract(root, before, removedSpecifier, eagerAfter, expectedBefore, expectedAfter) {
  const original = JSON.stringify(before);
  const after = { ...before, modules: before.modules.map(m => ({ ...m, eager: eagerAfter.includes(m.path) })), edges: before.edges.filter(e => e.specifier !== removedSpecifier) };
  assert.equal(after.edges.length, before.edges.length - 1);
  assert.deepEqual(after.modules.map(({ path, bytes }) => ({ path, bytes })), before.modules.map(({ path, bytes }) => ({ path, bytes })));
  positive(root, before, expectedBefore);
  positive(root, after, expectedAfter);
  assert.equal(JSON.stringify(before), original);
  const restored = { ...after, modules: before.modules.map(m => ({ ...m })), edges: [...after.edges, before.edges.find(e => e.specifier === removedSpecifier)] };
  positive(root, restored, expectedBefore);
  assert.equal(JSON.stringify(before), original);
}

test('diamond removal makes a dominate while b remains non-eager', () => withScratch(root => {
  const before = { entry: 'e', modules: modules(['e', 'a', 'b', 't']), edges: [edge('e','a','ea'), edge('e','b','eb'), edge('a','t','at'), edge('b','t','bt')] };
  contract(root, before, 'eb', ['e','a','t'], result(['e','t']), result(['a','e','t']));
}));

test('removing chain bypass exposes the complete path', () => withScratch(root => {
  const before = { entry: 'e', modules: modules(['e', 'a', 'b', 't']), edges: [edge('e','a','ea'), edge('a','b','ab'), edge('b','t','bt'), edge('e','t','bypass')] };
  contract(root, before, 'bypass', ['e','a','b','t'], result(['e','t']), result(['a','b','e','t']));
}));

test('removing a parallel alias preserves dominators', () => withScratch(root => {
  const before = { entry: 'e', modules: modules(['e', 'a', 't']), edges: [edge('e','a','alias-one'), edge('e','a','alias-two'), edge('a','t','at')] };
  contract(root, before, 'alias-one', ['e','a','t'], result(['a','e','t']), result(['a','e','t']));
}));

test('removing a lazy bypass preserves dominators', () => withScratch(root => {
  const before = { entry: 'e', modules: modules(['e', 'a', 't']), edges: [edge('e','a','ea'), edge('a','t','at'), edge('e','t','lazy-bypass','lazy')] };
  contract(root, before, 'lazy-bypass', ['e','a','t'], result(['a','e','t']), result(['a','e','t']));
}));

test('removing the final path fails closed', () => withScratch(root => {
  const before = { entry: 'e', modules: modules(['e', 'a', 't']), edges: [edge('e','a','ea'), edge('a','t','at')] };
  positive(root, before, result(['a','e','t']));
  const after = { ...before, modules: modules(['e','a']), edges: [before.edges[0]] };
  const output = run(root, after);
  assert.notEqual(output.status, 0);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, 'graph\n');
}));

test('unknown endpoint fails closed without leaking input paths', () => withScratch(root => {
  const report = { entry: 'e', modules: modules(['e','a','t']), edges: [edge('e','a','ea'), edge('a','t','at'), edge('e','private/missing','private/specifier')] };
  const output = run(root, report);
  assert.notEqual(output.status, 0);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, 'graph\n');
}));
