import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-layers.mjs', import.meta.url).pathname;
const mod = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const layer = (depth, paths, bytes) => ({ depth, paths, bytes });
const output = (layers, unreachable = ['lazy']) => ({ entry: 'e', layers, unreachable });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
const check = (report, expected) => {
  const input = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  for (const fixture of [report, report, reversed]) {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
  }
  assert.equal(JSON.stringify(report), input);
};

const cases = [
  {
    name: 'chain shifts downstream depths with zero-byte intermediary',
    modules: [mod('e', 1), mod('a', 2), mod('b', 3), mod('lazy', 9, false)],
    edges: [edge('e', 'a', 'ea'), edge('a', 'b', 'ab'), edge('e', 'b', 'shortcut', 'lazy'), edge('e', 'lazy', 'lazy', 'lazy'), edge('a', null, 'unknown')],
    remove: 'ea', add: [edge('e', 'x', 'ex'), edge('x', 'a', 'xa')],
    before: output([layer(0, ['e'], 1), layer(1, ['a'], 2), layer(2, ['b'], 3)]),
    after: output([layer(0, ['e'], 1), layer(1, ['x'], 0), layer(2, ['a'], 2), layer(3, ['b'], 3)]),
  },
  {
    name: 'diamond preserves shortest path through the other branch',
    modules: [mod('e', 1), mod('a', 2), mod('b', 3), mod('c', 4), mod('lazy', 9, false)],
    edges: [edge('e', 'a', 'ea'), edge('e', 'b', 'eb'), edge('a', 'c', 'ac'), edge('b', 'c', 'bc'), edge('e', 'c', 'shortcut', 'lazy'), edge('e', 'lazy', 'lazy', 'lazy'), edge('a', null, 'unknown')],
    remove: 'ac', add: [edge('a', 'x', 'ax'), edge('x', 'c', 'xc')],
    before: output([layer(0, ['e'], 1), layer(1, ['a', 'b'], 5), layer(2, ['c'], 4)]),
    after: output([layer(0, ['e'], 1), layer(1, ['a', 'b'], 5), layer(2, ['c', 'x'], 4)]),
  },
  {
    name: 'interior edge shifts its descendants but not a sibling',
    modules: [mod('e', 1), mod('a', 2), mod('b', 3), mod('c', 4), mod('d', 5), mod('lazy', 9, false)],
    edges: [edge('e', 'a', 'ea'), edge('a', 'b', 'ab'), edge('b', 'c', 'bc'), edge('a', 'd', 'ad'), edge('e', 'c', 'shortcut', 'lazy'), edge('e', 'lazy', 'lazy', 'lazy'), edge('b', null, 'unknown')],
    remove: 'ab', add: [edge('a', 'x', 'ax'), edge('x', 'b', 'xb')],
    before: output([layer(0, ['e'], 1), layer(1, ['a'], 2), layer(2, ['b', 'd'], 8), layer(3, ['c'], 4)]),
    after: output([layer(0, ['e'], 1), layer(1, ['a'], 2), layer(2, ['d', 'x'], 5), layer(3, ['b'], 3), layer(4, ['c'], 4)]),
  },
];

for (const scenario of cases) {
  test(scenario.name, () => {
    const baseline = { entry: 'e', modules: scenario.modules, edges: scenario.edges };
    const transformed = { entry: 'e', modules: [...scenario.modules, mod('x', 0)], edges: [...scenario.edges.filter(item => item.specifier !== scenario.remove), ...scenario.add] };
    check(baseline, scenario.before);
    check(transformed, scenario.after);
  });
}

test('subdivision with a missing endpoint fails without output', () => {
  const scenario = cases[0];
  const report = { entry: 'e', modules: [...scenario.modules, mod('x', 0)], edges: [...scenario.edges.filter(item => item.specifier !== scenario.remove), edge('e', 'x', 'ex'), edge('x', 'missing', 'xm')] };
  const result = run(report);
  assert.notEqual(result.status, 0);
  assert.notEqual(result.status, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
