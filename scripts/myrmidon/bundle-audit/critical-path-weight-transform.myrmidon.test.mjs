import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-critical-path.mjs', import.meta.url));
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to, kind = 'eager', specifier = String(to)) => ({ from, to, kind, specifier });
const graphs = [
  { entry: 'a', modules: [m('a', 2), m('b', 3), m('c', 4)], edges: [e('a', 'b'), e('b', 'c')] },
  { entry: 'a', modules: [m('a', 1), m('b', 4), m('c', 4), m('d', 2), m('z', 0)], edges: [e('a', 'c'), e('a', 'b'), e('b', 'd'), e('c', 'd'), e('d', 'z')] },
  { entry: 'a', modules: [m('a', 3), m('b', 1), m('x', 90, false), m('y', 80, false)], edges: [e('a', 'b'), e('a', 'x', 'lazy'), e('x', 'y')] },
  { entry: 'a', modules: [m('a', 1), m('b', 2), m('c', 3)], edges: [e('a', 'b', 'eager', './b'), e('a', 'b', 'eager', './alias'), e('b', 'c')] },
];

// Enumerate every simple eager path, including each prefix as a candidate.
function oracle(report) {
  const weights = new Map(report.modules.map(({ path, bytes }) => [path, bytes]));
  const candidates = [];
  function visit(paths, bytes) {
    candidates.push({ paths, bytes });
    for (const edge of report.edges) {
      if (edge.from === paths.at(-1) && edge.kind === 'eager' && edge.to !== null && !paths.includes(edge.to)) {
        visit([...paths, edge.to], bytes + weights.get(edge.to));
      }
    }
  }
  visit([report.entry], weights.get(report.entry));
  candidates.sort((a, b) => {
    if (a.bytes !== b.bytes) return b.bytes - a.bytes;
    for (let i = 0; i < Math.min(a.paths.length, b.paths.length); i++) {
      if (a.paths[i] !== b.paths[i]) return a.paths[i] < b.paths[i] ? -1 : 1;
    }
    return a.paths.length - b.paths.length;
  });
  return { entry: report.entry, ...candidates[0] };
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}
function run(report) {
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}
function transform(report, k) {
  return { ...report, modules: report.modules.map(mod => ({ ...mod, bytes: mod.bytes * k })) };
}
function reverse(report) {
  return { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
}

test('positive scaling preserves the selected critical path and scales its cost', () => {
  for (const graph of graphs) {
    const base = oracle(graph);
    for (const k of [1, 2, 7]) {
      const scaled = transform(graph, k);
      const expected = { ...base, bytes: base.bytes * k };
      assert.deepEqual(oracle(scaled), expected);
      for (const report of [scaled, reverse(scaled)]) assertOutput(run(report), expected);
    }
  }
});

test('zero weights independently select the lexicographically first prefix', () => {
  for (const graph of graphs) {
    const zero = transform(graph, 0);
    const expected = oracle(zero);
    for (const report of [zero, reverse(zero)]) assertOutput(run(report), expected);
  }
});

test('output assertion rejects an incorrect byte count', () => {
  const expected = oracle(graphs[0]);
  const wrong = { ...expected, bytes: expected.bytes + 1 };
  assert.throws(() => assertOutput({ status: 0, stderr: '', stdout: `${JSON.stringify(wrong)}\n` }, expected), assert.AssertionError);
});
