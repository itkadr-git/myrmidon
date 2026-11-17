import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = name => fileURLToPath(new URL(`./import-report-${name}.mjs`, import.meta.url));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const edge = (from, to, kind = 'eager', specifier = `${from}-${to}`) => ({ from, to, kind, specifier });

function fixture(weights, edges) {
  const paths = Object.keys(weights);
  const reached = reachable('a', edges, 'eager');
  return { entry: 'a', modules: paths.map(path => ({ path, bytes: weights[path], eager: reached.has(path) })), edges };
}
function reachable(start, edges, mode) {
  const seen = new Set([start]), pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const e of edges) if (e.from === current && e.to !== null && (mode === 'all' || e.kind === 'eager') && !seen.has(e.to)) {
      seen.add(e.to); pending.push(e.to);
    }
  }
  return seen;
}
function condensationOracle(report, mode, k, c) {
  const paths = report.modules.map(m => m.path).sort(cmp);
  const reach = new Map(paths.map(path => [path, reachable(path, report.edges, mode)]));
  const groups = [], owner = new Map();
  for (const path of paths) {
    if (owner.has(path)) continue;
    const members = paths.filter(other => reach.get(path).has(other) && reach.get(other).has(path));
    for (const member of members) owner.set(member, path);
    const oldSum = members.reduce((sum, member) => sum + report.modules.find(m => m.path === member).bytes, 0);
    groups.push({ id: path, paths: members, bytes: k * oldSum + c * members.length });
  }
  const pairs = new Map();
  for (const e of report.edges) {
    if (e.to === null || (mode === 'eager' && e.kind !== 'eager')) continue;
    const from = owner.get(e.from), to = owner.get(e.to);
    if (from !== to) pairs.set(JSON.stringify([from, to]), { from, to });
  }
  return { entry: report.entry, components: groups, edges: [...pairs.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)) };
}
function criticalOracle(report, k) {
  const weights = new Map(report.modules.map(m => [m.path, m.bytes * k]));
  // Enumerate all simple entry paths, including paths that stop early.
  function visit(path, prefix) {
    const current = [...prefix, path];
    const choices = [{ paths: current, bytes: current.reduce((sum, p) => sum + weights.get(p), 0) }];
    const next = new Set(report.edges.filter(e => e.from === path && e.kind === 'eager' && e.to !== null).map(e => e.to));
    for (const target of next) {
      assert.ok(!current.includes(target), 'critical-path fixture must be a DAG');
      choices.push(...visit(target, current));
    }
    return choices;
  }
  const candidates = visit(report.entry, []);
  candidates.sort((a, b) => b.bytes - a.bytes || cmp(a.paths.join('\0'), b.paths.join('\0')));
  return { entry: report.entry, ...candidates[0] };
}
function assertOutput(actual, expected) { assert.deepEqual(actual, expected); }
function run(name, report, expected, args = []) {
  const result = spawnSync(process.execPath, [cli(name), ...args], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  assertOutput(JSON.parse(result.stdout), expected);
}
const graphs = [
  fixture({ a: 2, b: 3, c: 7 }, [edge('a', 'b'), edge('b', 'c')]),
  fixture({ a: 2, b: 5, c: 3, d: 7 }, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]),
  fixture({ a: 2, b: 3, c: 5, x: 11 }, [edge('a', 'b'), edge('b', 'c', 'lazy'), edge('c', 'b'), edge('x', 'x')]),
  fixture({ a: 3, b: 4, c: 6 }, [edge('a', 'b', 'eager', 'alias-one'), edge('a', 'b', 'eager', 'alias-two'), edge('b', 'c'), edge('a', null)]),
];
function transformed(report, k, c) {
  return { ...report, modules: report.modules.map(m => ({ ...m, bytes: k * m.bytes + c })) };
}
function permutations(report) {
  return [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }];
}

test('SCC identities and affine component weights match mutual reachability', () => {
  for (const graph of graphs) for (const mode of ['eager', 'all']) for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
    const expected = condensationOracle(graph, mode, k, c);
    for (const input of permutations(transformed(graph, k, c))) run('condensation', input, expected, [mode]);
  }
  assert.deepEqual(condensationOracle(graphs[2], 'eager', 1, 0).components.map(x => x.paths), [['a'], ['b'], ['c'], ['x']]);
  assert.deepEqual(condensationOracle(graphs[2], 'all', 1, 0).components.map(x => x.paths), [['a'], ['b', 'c'], ['x']]);
});

test('critical path scales on DAGs and zero weights choose the entry alone', () => {
  for (const graph of [graphs[0], graphs[1], graphs[3]]) for (const k of [0, 1, 3]) {
    const expected = criticalOracle(graph, k);
    for (const input of permutations(transformed(graph, k, 0))) run('critical-path', input, expected);
  }
});

test('assertion rejects a wrong byte count and empty output', () => {
  const expected = condensationOracle(graphs[1], 'all', 3, 2);
  const wrong = structuredClone(expected);
  wrong.components[0].bytes++;
  assert.throws(() => assertOutput(wrong, expected), assert.AssertionError);
  assert.throws(() => assertOutput({}, expected), assert.AssertionError);
  const path = criticalOracle(graphs[1], 3);
  assert.throws(() => assertOutput({ ...path, bytes: path.bytes + 1 }, path), assert.AssertionError);
});
