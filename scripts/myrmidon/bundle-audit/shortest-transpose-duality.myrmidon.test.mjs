import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const edge = (from, to, kind, specifier) => ({ from, to, kind, specifier });

// Enumerate vertex sequences rather than edges: aliases do not multiply paths.
function oracle(names, edges, entry) {
  const paths = [];
  function visit(path) {
    paths.push(path);
    for (const target of names) {
      if (!path.includes(target) && edges.some(e => e.kind === 'eager' && e.from === path.at(-1) && e.to === target)) {
        visit([...path, target]);
      }
    }
  }
  visit([entry]);
  const modules = [], unreachable = [];
  for (const name of [...names].sort()) {
    const candidates = paths.filter(path => path.at(-1) === name);
    if (!candidates.length) { unreachable.push(name); continue; }
    const shortest = Math.min(...candidates.map(path => path.length));
    modules.push({ path: name, depth: shortest - 1, shortestPaths: String(candidates.filter(path => path.length === shortest).length) });
  }
  return { entry, modules, unreachable };
}

function report(names, edges, entry) {
  const reachable = new Set([entry]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (e.kind === 'eager' && e.to !== null && reachable.has(e.from) && !reachable.has(e.to)) {
        reachable.add(e.to);
        changed = true;
      }
    }
  }
  return { entry, modules: names.map((path, index) => ({ path, bytes: index + 1, eager: reachable.has(path) })), edges };
}

// Do not include fixture or output payloads in failure diagnostics.
function assertResult(actual, expected) {
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'complete shortest report differs from oracle');
}

function run(input, expected) {
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  assert.ok(!result.error && result.status === 0 && result.stderr === '', 'shortest CLI failed');
  let actual;
  try { actual = JSON.parse(result.stdout); } catch { assert.fail('shortest CLI returned invalid JSON'); }
  assertResult(actual, expected);
  return actual;
}

const cases = [
  { name: 'asymmetric chain', names: ['a', 'b', 'c', 'd'], edges: [edge('a', 'b', 'eager', 'ab'), edge('b', 'c', 'eager', 'bc'), edge('c', null, 'eager', 'external')] },
  { name: 'diamond and aliases', names: ['a', 'b', 'c', 'd'], edges: [edge('a', 'b', 'eager', 'ab'), edge('a', 'b', 'eager', 'alias'), edge('a', 'c', 'eager', 'ac'), edge('b', 'd', 'eager', 'bd'), edge('c', 'd', 'eager', 'cd')] },
  { name: 'cycle and lazy shortcut', names: ['a', 'b', 'c', 'd'], edges: [edge('a', 'b', 'eager', 'ab'), edge('b', 'c', 'eager', 'bc'), edge('c', 'a', 'eager', 'ca'), edge('c', 'd', 'eager', 'cd'), edge('a', 'd', 'lazy', 'shortcut'), edge('d', null, 'lazy', 'external')] },
];

test('shortest paths transpose for every ordered pair and reversed input order', () => {
  for (const fixture of cases) {
    const { names, edges } = fixture;
    const transpose = edges.map(e => e.to === null ? { ...e } : { ...e, from: e.to, to: e.from });
    const forward = new Map(), backward = new Map();
    for (const [graph, results] of [[edges, forward], [transpose, backward]]) {
      for (const entry of names) {
        const expected = oracle(names, graph, entry);
        const input = report(names, graph, entry);
        const actual = run(input, expected);
        run({ ...input, modules: [...input.modules].reverse(), edges: [...input.edges].reverse() }, expected);
        results.set(entry, actual);
        const self = actual.modules.find(m => m.path === entry);
        assert.ok(self.depth === 0 && self.shortestPaths === '1', `${fixture.name}: entry path`);
      }
    }
    for (const s of names) for (const t of names) {
      const a = forward.get(s).modules.find(m => m.path === t);
      const b = backward.get(t).modules.find(m => m.path === s);
      assert.ok((!a && !b) || (a && b && a.depth === b.depth && a.shortestPaths === b.shortestPaths), `${fixture.name}: transpose pair ${s},${t}`);
    }
  }
});

test('assertion rejects missing reachable vertex and incorrect count', () => {
  const { names, edges } = cases[1];
  const expected = oracle(names, edges, 'a');
  assert.ok(expected.modules.length > 1);
  const missing = structuredClone(expected);
  missing.modules.pop();
  assert.throws(() => assertResult(missing, expected), { code: 'ERR_ASSERTION' });
  const badCount = structuredClone(expected);
  badCount.modules.find(m => m.path === 'd').shortestPaths = '1';
  assert.throws(() => assertResult(badCount, expected), { code: 'ERR_ASSERTION' });
  assertResult(expected, expected);
});
