import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-boundaries.mjs', import.meta.url));
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const E = (from, to) => edge(from, to, 'eager', to);
const L = (from, specifier, to) => edge(from, specifier, 'lazy', to);
const fixtures = [
  { name: 'chain', weights: { e: 2, a: 3, b: 5, c: 7 }, edges: [E('e', 'a'), L('a', 'load', 'b'), E('b', 'c')] },
  { name: 'diamond', weights: { e: 2, root: 3, left: 5, right: 7, shared: 11 }, edges: [L('e', 'load', 'root'), E('root', 'left'), E('root', 'right'), E('left', 'shared'), E('right', 'shared'), E('shared', 'left')] },
  { name: 'unreachable and lazy sources', weights: { e: 2, a: 3, target: 5, nested: 7, orphan: 11 }, edges: [E('e', 'a'), L('e', 'target', 'target'), L('target', 'nested', 'nested'), L('orphan', 'ignored', 'nested'), E('target', 'a'), L('a', 'eager', 'a'), L('e', 'external', null)] },
  { name: 'aliases and parallel imports', weights: { e: 2, a: 3, target: 5, child: 7 }, edges: [E('e', 'a'), L('e', './target', 'target'), L('e', '@alias', 'target'), L('a', 'other', 'target'), edge('target', 'one', 'eager', 'child'), edge('target', 'two', 'eager', 'child')] },
];

// Walk the graph directly, independently of the CLI's cached aggregation.
function closure(start, edges) {
  const seen = new Set();
  function visit(node) {
    if (seen.has(node)) return;
    seen.add(node);
    for (const e of edges) if (e.from === node && e.kind === 'eager' && e.to !== null) visit(e.to);
  }
  visit(start);
  return seen;
}
function expected(fixture, k, c) {
  const eager = closure('e', fixture.edges);
  const boundaries = [];
  for (const e of fixture.edges) {
    if (e.kind !== 'lazy' || e.to === null || !eager.has(e.from) || eager.has(e.to)) continue;
    const selected = [...closure(e.to, fixture.edges)].filter(path => !eager.has(path));
    const oldBytes = selected.reduce((sum, path) => sum + fixture.weights[path], 0);
    boundaries.push({ from: e.from, specifier: e.specifier, to: e.to, bytes: k * oldBytes + c * selected.length });
  }
  boundaries.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
  return { entry: 'e', boundaries };
}
function assertOutput(actual, wanted) {
  assert.deepStrictEqual(actual, wanted);
}

test('lazy frontier costs follow the affine transform and preserve identities', () => {
  for (const fixture of fixtures) {
    const eager = closure('e', fixture.edges);
    for (const k of [0, 1, 3]) for (const c of [0, 2, 11]) {
      const wanted = expected(fixture, k, c);
      assert.ok(wanted.boundaries.length > 0, fixture.name);
      const modules = Object.entries(fixture.weights).map(([path, bytes]) => ({ path, bytes: k * bytes + c, eager: eager.has(path) }));
      for (const reverse of [false, true]) {
        const report = { entry: 'e', modules: reverse ? [...modules].reverse() : modules, edges: reverse ? [...fixture.edges].reverse() : fixture.edges };
        const result = spawnSync(process.execPath, [cli, '-'], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
        assert.equal(result.stderr, '');
        assertOutput(JSON.parse(result.stdout), wanted);
        assert.equal(result.stdout, `${JSON.stringify(wanted)}\n`);
      }
      const wrong = structuredClone(wanted);
      wrong.boundaries[0].bytes++;
      assert.throws(() => assertOutput(wrong, wanted), assert.AssertionError);
    }
  }
});
