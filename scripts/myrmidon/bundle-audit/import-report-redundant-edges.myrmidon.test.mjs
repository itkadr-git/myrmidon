import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-redundant-edges.mjs', import.meta.url).pathname;
const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
const edge = (from, to, specifier = to ?? 'external', kind = 'eager') => ({ from, to, specifier, kind });
const graph = (paths, edges) => ({ entry: paths[0], modules: paths.map(path => ({ path, bytes: 0, eager: true })), edges });

// Structural redundancy does not prove that removing an import is safe: side effects and order are not analyzed.
function check(report, expected) {
  const result = run(JSON.stringify(report));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, { entry: report.entry, redundant: expected });
  assert.equal(run(JSON.stringify({ ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() })).stdout, result.stdout);
  for (const candidate of output.redundant) {
    const edges = report.edges.filter(e => e.kind === 'eager' && e.to !== null && !(e.from === candidate.from && e.to === candidate.to && e.specifier === candidate.specifier));
    const path = candidate.alternativePath;
    assert.equal(path[0], candidate.from); assert.equal(path.at(-1), candidate.to);
    for (let i = 1; i < path.length; i++) assert.ok(edges.some(e => e.from === path[i - 1] && e.to === path[i]));
    const distance = new Map([[candidate.from, 0]]), queue = [candidate.from];
    for (const from of queue) for (const e of edges) if (e.from === from && !distance.has(e.to)) { distance.set(e.to, distance.get(from) + 1); queue.push(e.to); }
    assert.equal(path.length - 1, distance.get(candidate.to));
  }
}
const found = (from, specifier, to, alternativePath) => ({ from, specifier, to, alternativePath });

test('empty graph, chain and simple cycle have no redundant edges', () => {
  check(graph(['e'], []), []);
  check(graph(['e', 'a', 'b'], [edge('e', 'a'), edge('a', 'b')]), []);
  check(graph(['e', 'a', 'b'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'e'), edge('e', 'e')]), []);
});
test('triangle and diamond choose shortest lexicographic path', () => {
  check(graph(['e', 'a', 'b', 'z'], [edge('e', 'z'), edge('e', 'b'), edge('b', 'z'), edge('e', 'a'), edge('a', 'z')]), [found('e', 'z', 'z', ['e', 'a', 'z'])]);
});
test('parallel specifiers are removed independently', () => {
  check(graph(['e', 'a'], [edge('e', 'a', 'one'), edge('e', 'a', 'two')]), [found('e', 'one', 'a', ['e', 'a']), found('e', 'two', 'a', ['e', 'a'])]);
});
test('lazy and null edges are not alternatives', () => {
  check(graph(['e', 'a', 'b'], [edge('e', 'b'), edge('e', 'a'), edge('a', 'b', 'lazy', 'lazy'), edge('e', null)]), []);
});
test('cycle shortcut and disconnected triangle are analyzed', () => {
  check(graph(['e', 'a', 'b', 'c', 'x', 'y', 'z'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('a', 'c'), edge('x', 'z'), edge('x', 'y'), edge('y', 'z')]), [found('a', 'c', 'c', ['a', 'b', 'c']), found('x', 'z', 'z', ['x', 'y', 'z'])]);
});
test('bad arguments, JSON, shapes, references and duplicates fail without leaking input', () => {
  const valid = graph(['secret', 'other'], []);
  const cases = [['{secret', []], [JSON.stringify(valid), ['secret-arg']], ['{}', []],
    [JSON.stringify({ ...valid, entry: 'missing' }), []],
    [JSON.stringify({ ...valid, modules: [valid.modules[0], valid.modules[0]] }), []],
    [JSON.stringify({ ...valid, modules: [{ ...valid.modules[0], bytes: Number.MAX_SAFE_INTEGER + 1 }] }), []],
    [JSON.stringify({ ...valid, edges: [edge('secret', 'missing')] }), []],
    [JSON.stringify({ ...valid, edges: [edge('secret', 'other'), edge('secret', 'other')] }), []]];
  for (const [input, args] of cases) { const r = run(input, args); assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.ok(r.stderr); assert.ok(!r.stderr.includes('secret')); }
});
