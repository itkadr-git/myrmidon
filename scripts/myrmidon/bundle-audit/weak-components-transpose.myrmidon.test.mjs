import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const moduleOf = (path, bytes, eager = false) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const report = {
  entry: 'a',
  modules: [moduleOf('a', 2, true), moduleOf('b', 3), moduleOf('c', 5),
    moduleOf('d', 7), moduleOf('e', 11), moduleOf('z', 13)],
  edges: [edge('a', 'ab', 'eager', 'b'), edge('a', 'alias-ab', 'eager', 'b'),
    edge('b', 'loop', 'eager', 'b'), edge('b', 'bridge', 'lazy', 'c'),
    edge('d', 'de', 'eager', 'e'), edge('a', 'external', 'lazy', null)],
};
const manual = {
  eager: {entry:'a', components:[{id:'a',paths:['a','b'],bytes:5}, {id:'c',paths:['c'],bytes:5},
    {id:'d',paths:['d','e'],bytes:18}, {id:'z',paths:['z'],bytes:13}]},
  all: {entry:'a', components:[{id:'a',paths:['a','b','c'],bytes:10},
    {id:'d',paths:['d','e'],bytes:18}, {id:'z',paths:['z'],bytes:13}]},
};

// Build the oracle solely from the fixture, treating selected edges as undirected.
function oracle(input, mode) {
  const unseen = new Set(input.modules.map(mod => mod.path));
  const bytes = new Map(input.modules.map(mod => [mod.path, mod.bytes]));
  const selected = input.edges.filter(e => e.to !== null && (mode === 'all' || e.kind === 'eager'));
  const components = [];
  while (unseen.size) {
    const start = [...unseen].sort()[0];
    const queue = [start];
    unseen.delete(start);
    for (let i = 0; i < queue.length; i++) {
      for (const e of selected) {
        const next = e.from === queue[i] ? e.to : e.to === queue[i] ? e.from : null;
        if (next !== null && unseen.delete(next)) queue.push(next);
      }
    }
    const paths = queue.sort();
    components.push({id: paths[0], paths, bytes: paths.reduce((sum, path) => sum + bytes.get(path), 0)});
  }
  return {entry: input.entry, components};
}

// Compare without printing the fixture or report on a failure.
function assertResult(actual, expected) {
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'component result differs from expected');
}
function run(input, mode, expected) {
  const child = spawnSync(process.execPath, [cli, mode], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: homedir(), timeout: 10000,
  });
  assert.equal(child.status, 0, 'CLI did not succeed');
  assert.equal(child.stderr, '', 'CLI wrote to stderr');
  let parsed;
  try { parsed = JSON.parse(child.stdout); } catch { assert.fail('CLI did not return JSON'); }
  assertResult(parsed, expected);
  assert.ok(child.stdout.endsWith('\n'), 'CLI did not terminate output with newline');
}

test('transpose preserves exact weak components in eager and all modes', () => {
  const transposed = {...report, edges: report.edges.map(e => e.to === null ? {...e} :
    {...e, from: e.to, to: e.from})};
  for (const mode of ['eager', 'all']) {
    const expected = oracle(report, mode);
    assertResult(expected, manual[mode]);
    assertResult(oracle(transposed, mode), manual[mode]);
    for (const graph of [report, transposed]) {
      run(graph, mode, expected);
      run({...graph, modules: [...graph.modules].reverse(), edges: [...graph.edges].reverse()}, mode, expected);
    }
    const missing = structuredClone(expected);
    missing.components.pop();
    assert.throws(() => assertResult(missing, expected));
    assert.throws(() => assertResult({...expected, components: []}, expected));
  }
});
