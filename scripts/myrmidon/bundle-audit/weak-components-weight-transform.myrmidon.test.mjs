import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const edge = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });

// Eager flags describe directed eager reachability from the entry, not weak membership.
function graph(weights, edges) {
  const reached = new Set(['a']);
  const queue = ['a'];
  for (const from of queue) {
    for (const e of edges) {
      if (e.from === from && e.kind === 'eager' && e.to !== null && !reached.has(e.to)) {
        reached.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return { entry: 'a', modules: Object.entries(weights).map(([path, bytes]) => ({ path, bytes, eager: reached.has(path) })), edges };
}

const graphs = {
  chain: graph({ a: 2, b: 5, c: 7 }, [edge('a', 'b'), edge('b', 'c')]),
  diamond: graph({ a: 1, b: 3, c: 6, d: 9 }, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]),
  bridge: graph({ a: 4, b: 2, c: 8, d: 3, z: 5 }, [edge('a', 'b'), edge('b', 'c', 'lazy'), edge('c', 'd'), edge('a', null, 'eager', 'external')]),
  aliases: graph({ a: 3, b: 4, c: 10, x: 6 }, [edge('a', 'b', 'eager', './b'), edge('a', 'b', 'eager', 'alias-b'), edge('b', 'c'), edge('c', 'a'), edge('x', 'b', 'lazy')]),
};

// Traverse edges in both directions without deriving expectations from CLI output.
function oracle(report, mode, k, c) {
  const remaining = new Set(report.modules.map(m => m.path));
  const weights = new Map(report.modules.map(m => [m.path, m.bytes]));
  const components = [];
  while (remaining.size) {
    const start = [...remaining].sort()[0];
    const queue = [start];
    remaining.delete(start);
    for (const path of queue) {
      for (const e of report.edges) {
        if (e.to === null || (mode === 'eager' && e.kind !== 'eager')) continue;
        const neighbor = e.from === path ? e.to : e.to === path ? e.from : null;
        if (neighbor !== null && remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    const paths = queue.sort();
    const oldBytes = paths.reduce((sum, path) => sum + weights.get(path), 0);
    components.push({ id: paths[0], paths, bytes: k * oldBytes + c * paths.length });
  }
  return { entry: report.entry, components };
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

function run(report, mode) {
  return spawnSync(process.execPath, [cli, mode], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
  });
}

for (const [name, report] of Object.entries(graphs)) {
  test(`${name}: affine weights preserve weak components in eager and all modes`, () => {
    for (const mode of ['eager', 'all']) {
      for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
        const expected = oracle(report, mode, k, c);
        const transformed = { ...report, modules: report.modules.map(m => ({ ...m, bytes: k * m.bytes + c })) };
        for (const permuted of [false, true]) {
          const input = permuted ? { ...transformed, modules: [...transformed.modules].reverse(), edges: [...transformed.edges].reverse() } : transformed;
          assertOutput(run(input, mode), expected);
        }
      }
    }
  });
}

test('lazy bridge joins weak components only in all mode', () => {
  const eager = oracle(graphs.bridge, 'eager', 1, 0);
  const all = oracle(graphs.bridge, 'all', 1, 0);
  assert.deepEqual(eager.components.map(component => component.paths), [['a', 'b'], ['c', 'd'], ['z']]);
  assert.deepEqual(all.components.map(component => component.paths), [['a', 'b', 'c', 'd'], ['z']]);
  assertOutput(run(graphs.bridge, 'eager'), eager);
  assertOutput(run(graphs.bridge, 'all'), all);
});

test('assertion rejects a separately constructed incorrect byte total', () => {
  const expected = oracle(graphs.diamond, 'all', 1, 0);
  const wrong = structuredClone(expected);
  wrong.components[0].bytes += 1;
  assert.throws(() => assertOutput({ status: 0, stderr: '', stdout: JSON.stringify(wrong) + '\n' }, expected), assert.AssertionError);
});
