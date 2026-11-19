import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));

function fixture(width, layers, extraChain, detour) {
  const modules = [{ path: 'entry', bytes: 0, eager: true }];
  const edges = [];
  const addModule = path => { modules.push({ path, bytes: 0, eager: true }); return path; };
  const connect = (from, to) => edges.push({ from, to, specifier: to, kind: 'eager' });
  let previous = ['entry'];
  const levels = [];
  for (let level = 0; level < layers; level++) {
    const current = Array.from({ length: width }, (_, column) => addModule(`level-${level}-${column}`));
    for (const from of previous) for (const to of current) connect(from, to);
    levels.push(current);
    previous = current;
  }
  addModule('end');
  for (const from of previous) connect(from, 'end');
  if (extraChain) {
    let from = 'entry';
    for (let level = 0; level < layers; level++) {
      const to = addModule(`chain-${level}`);
      connect(from, to);
      from = to;
    }
    connect(from, 'end');
  }
  if (detour) {
    let from = 'entry';
    for (let level = 0; level <= layers; level++) {
      const to = addModule(`detour-${level}`);
      connect(from, to);
      from = to;
    }
    connect(from, 'end');
  }
  return { report: { entry: 'entry', modules, edges }, levels };
}

for (const { width, layers, extraChain } of [
  { width: 2, layers: 52, extraChain: true },
  { width: 2, layers: 53, extraChain: false },
  { width: 2, layers: 54, extraChain: true },
  { width: 3, layers: 35, extraChain: true },
]) {
  test(`exact shortest paths: width ${width}, layers ${layers}, extra chain ${extraChain}`, () => {
    const expectedEnd = BigInt(width) ** BigInt(layers) + BigInt(extraChain);
    for (const detour of [false, true]) {
      const { report, levels } = fixture(width, layers, extraChain, detour);
      const result = spawnSync(process.execPath, [cli], {
        input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.entry, 'entry');
      assert.deepEqual(output.unreachable, []);
      assert.equal(output.modules.length, report.modules.length);
      const byPath = new Map(output.modules.map(module => [module.path, module]));
      const check = (path, depth, expected) => {
        const module = byPath.get(path);
        assert.ok(module, `missing ${path}`);
        assert.equal(module.depth, depth, path);
        assert.equal(typeof module.shortestPaths, 'string', path);
        assert.match(module.shortestPaths, /^(0|[1-9][0-9]*)$/, path);
        assert.equal(module.shortestPaths, expected.toString(), path);
      };
      check('entry', 0, 1n);
      for (let level = 0; level < layers; level++) {
        const expected = BigInt(width) ** BigInt(level);
        for (const path of levels[level]) check(path, level + 1, expected);
        if (extraChain) check(`chain-${level}`, level + 1, 1n);
        if (detour) check(`detour-${level}`, level + 1, 1n);
      }
      if (detour) check(`detour-${layers}`, layers + 1, 1n);
      check('end', layers + 1, expectedEnd);
    }
  });
}
