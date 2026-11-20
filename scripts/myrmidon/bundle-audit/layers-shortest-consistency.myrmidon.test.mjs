import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const layersCli = fileURLToPath(new URL('./import-report-layers.mjs', import.meta.url));
const shortestCli = process.env.MYRMIDON_SHORTEST_CLI || fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));

function run(cli, args = [], input) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.endsWith('\n'));
  return { text: result.stdout, json: JSON.parse(result.stdout) };
}

function check(input, entry, expectedModules, expectedLayers, unreachable) {
  const layers = run(layersCli, [], input).json;
  const shortest = run(shortestCli, [], input).json;
  assert.deepEqual(layers, { entry, layers: expectedLayers, unreachable });
  assert.deepEqual(shortest, { entry, modules: expectedModules, unreachable });
  const expanded = layers.layers.flatMap(({ depth, paths }) => paths.map(path => ({ path, depth })));
  const depths = shortest.modules.map(({ path, depth }) => ({ path, depth }));
  const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  assert.deepEqual(expanded.sort(byPath), depths.sort(byPath));
  assert.deepEqual([...expanded.map(m => m.path), ...layers.unreachable].sort(), JSON.parse(input).modules.map(m => m.path).sort());
}

const mod = (path, eager = true) => ({ path, bytes: 1, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });
const item = (path, depth, shortestPaths = '1') => ({ path, depth, shortestPaths });
const layer = (depth, ...paths) => ({ depth, paths, bytes: paths.length });

const cases = [
  ['chain', ['e', 'a', 'b'], [edge('e', 'a'), edge('a', 'b')], [item('a', 1), item('b', 2), item('e', 0)], [layer(0, 'e'), layer(1, 'a'), layer(2, 'b')], []],
  ['diamond', ['e', 'a', 'b', 'c'], [edge('e', 'a'), edge('e', 'b'), edge('a', 'c'), edge('b', 'c')], [item('a', 1), item('b', 1), item('c', 2, '2'), item('e', 0)], [layer(0, 'e'), layer(1, 'a', 'b'), layer(2, 'c')], []],
  ['eager cycle', ['e', 'a', 'b'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'a')], [item('a', 1), item('b', 2), item('e', 0)], [layer(0, 'e'), layer(1, 'a'), layer(2, 'b')], []],
  ['lazy shortcut', ['e', 'a', 'b'], [edge('e', 'a'), edge('a', 'b'), edge('e', 'b', 'lazy')], [item('a', 1), item('b', 2), item('e', 0)], [layer(0, 'e'), layer(1, 'a'), layer(2, 'b')], []],
  ['disconnected', ['e', 'a', 'z'], [edge('e', 'a')], [item('a', 1), item('e', 0)], [layer(0, 'e'), layer(1, 'a')], ['z']],
];

for (const [name, names, edges, modules, layers, unreachable] of cases) {
  test(`cross-report ${name}`, () => {
    const report = { entry: 'e', modules: names.map(path => mod(path, !unreachable.includes(path))), edges };
    check(JSON.stringify(report), 'e', modules, layers, unreachable);
  });
}

test('scanner output feeds both consumers without executing fixture modules', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'layers-shortest-'));
  try {
    const sentinel = join(dir, 'executed');
    const trap = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('fixture executed');\n`;
    const sources = {
      'entry.mjs': `import './a.mjs';\nimport('./b.mjs');\n${trap}`,
      'a.mjs': `import './b.mjs';\n${trap}`,
      'b.mjs': trap,
    };
    for (const [path, source] of Object.entries(sources)) writeFileSync(join(dir, path), source);
    const scanned = run(scanner, [join(dir, 'entry.mjs')]);
    assert.equal(existsSync(sentinel), false);
    check(scanned.text, 'entry.mjs', [item('a.mjs', 1), item('b.mjs', 2), item('entry.mjs', 0)], [
      { depth: 0, paths: ['entry.mjs'], bytes: Buffer.byteLength(sources['entry.mjs']) },
      { depth: 1, paths: ['a.mjs'], bytes: Buffer.byteLength(sources['a.mjs']) },
      { depth: 2, paths: ['b.mjs'], bytes: Buffer.byteLength(sources['b.mjs']) },
    ], []);
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
