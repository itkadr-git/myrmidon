import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-redundant-edges.mjs', import.meta.url);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const run = report => spawnSync(process.execPath, [cli.pathname], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});

// Compute reachability independently from the fixture's original relation.
function fixture(paths, relation, count) {
  const reached = new Set([paths[0]]);
  let changed;
  do {
    changed = false;
    for (const [from, to, kind = 'eager'] of relation) {
      if (kind === 'eager' && to !== null && reached.has(from) && !reached.has(to)) {
        reached.add(to); changed = true;
      }
    }
  } while (changed);
  const edges = relation.flatMap(([from, to, kind = 'eager'], index) =>
    Array.from({ length: to === null ? 1 : count }, (_, alias) => ({
      from, to, kind, specifier: `import-${index}-${alias}`,
    })));
  return { entry: paths[0], modules: paths.map((path, i) => ({ path, bytes: 100 + i, eager: reached.has(path) })), edges };
}

// Delete one complete tuple, then search shortest paths in lexical order.
function oracle(report) {
  const result = [];
  for (const candidate of report.edges) {
    if (candidate.kind !== 'eager' || candidate.to === null || candidate.from === candidate.to) continue;
    const remaining = report.edges.filter(edge => edge.kind === 'eager' && edge.to !== null &&
      !(edge.from === candidate.from && edge.specifier === candidate.specifier && edge.kind === candidate.kind && edge.to === candidate.to));
    const queue = [[candidate.from]];
    const visited = new Set([candidate.from]);
    let path;
    for (let i = 0; i < queue.length && !path; i++) {
      const current = queue[i];
      const neighbours = remaining.filter(edge => edge.from === current.at(-1))
        .map(edge => edge.to).sort(compare);
      for (const next of neighbours) {
        if (visited.has(next)) continue;
        const nextPath = [...current, next];
        if (next === candidate.to) { path = nextPath; break; }
        visited.add(next); queue.push(nextPath);
      }
    }
    if (path) result.push({ from: candidate.from, specifier: candidate.specifier, to: candidate.to, alternativePath: path });
  }
  result.sort((a, b) => compare(a.from, b.from) || compare(a.specifier, b.specifier) || compare(a.to, b.to));
  return { entry: report.entry, redundant: result };
}

function check(report, expected) {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

const cases = [
  ['chain', ['entry', 'a', 'b'], [['entry', 'a'], ['a', 'b']]],
  ['diamond with suffix and self-loop', ['entry', 'a', 'b', 'join', 'end'],
    [['entry', 'end'], ['entry', 'b'], ['entry', 'a'], ['a', 'join'], ['b', 'join'], ['join', 'end'], ['join', 'join']]],
  ['cycle with exit', ['entry', 'a', 'b', 'exit'],
    [['entry', 'a'], ['a', 'b'], ['b', 'a'], ['a', 'exit'], ['b', 'exit']]],
  ['mixed disconnected', ['entry', 'a', 'b', 'x', 'y', 'z'],
    [['entry', 'a'], ['entry', 'b'], ['a', 'b', 'lazy'], ['a', null], ['x', 'y'], ['y', 'z'], ['x', 'z'], ['z', 'z']]],
];

test('multiplicity matrix matches independent tuple-removal BFS under permutations', () => {
  let nonempty = false;
  for (const [name, paths, relation] of cases) {
    const baseModules = fixture(paths, relation, 1).modules;
    for (const count of [1, 2, 4]) {
      const report = fixture(paths, relation, count);
      assert.deepEqual(report.modules, baseModules, `${name}: modules changed`);
      const expected = oracle(report);
      nonempty ||= expected.redundant.length > 0;
      check(report, expected);
      check({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }, expected);
    }
  }
  assert.ok(nonempty);
});

test('assertion rejects a corrupted expected path', () => {
  const report = fixture(['entry', 'a'], [['entry', 'a']], 2);
  const expected = oracle(report);
  assert.ok(expected.redundant.length);
  const corrupted = structuredClone(expected);
  corrupted.redundant[0].alternativePath.push('bogus');
  assert.throws(() => check(report, corrupted), assert.AssertionError);
});

test('exact duplicate tuple is rejected without stdout', () => {
  const report = fixture(['entry', 'a'], [['entry', 'a']], 2);
  report.edges.push({ ...report.edges[0] });
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.length > 0);
});
