import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-redundant-edges.mjs', import.meta.url));
const edge = (from, to, specifier = to, kind = 'eager') => ({ from, specifier, kind, to });
const report = (entry, modules, edges) => ({ entry, modules, edges });
const output = (entry, redundant) => `${JSON.stringify({ entry, redundant })}\n`;
const run = input => spawnSync(process.execPath, [cli], { input, encoding: 'utf8', timeout: 5000 });

const cases = [
  {
    name: 'chain and disconnected triangle',
    a: report('a0', [{ path: 'a0', bytes: 1, eager: true }, { path: 'a1', bytes: 2, eager: true }], [edge('a0', 'a1')]),
    b: report('b0', [{ path: 'b0', bytes: 3, eager: true }, { path: 'b1', bytes: 5, eager: true }, { path: 'b2', bytes: 8, eager: true }], [edge('b0', 'b2'), edge('b0', 'b1'), edge('b1', 'b2')]),
    expectedA: [],
    expectedB: [{ from: 'b0', specifier: 'b2', to: 'b2', alternativePath: ['b0', 'b1', 'b2'] }],
    expectedUnion: [{ from: 'b0', specifier: 'b2', to: 'b2', alternativePath: ['b0', 'b1', 'b2'] }],
  },
  {
    name: 'two triangles in reverse component order',
    a: report('z0', [{ path: 'z0', bytes: 13, eager: true }, { path: 'z1', bytes: 17, eager: true }, { path: 'z2', bytes: 19, eager: true }], [edge('z0', 'z2', 'shortcut'), edge('z0', 'z1'), edge('z1', 'z2')]),
    b: report('c0', [{ path: 'c0', bytes: 23, eager: true }, { path: 'c1', bytes: 29, eager: true }, { path: 'c2', bytes: 31, eager: true }], [edge('c0', 'c2', 'shortcut'), edge('c0', 'c1'), edge('c1', 'c2')]),
    expectedA: [{ from: 'z0', specifier: 'shortcut', to: 'z2', alternativePath: ['z0', 'z1', 'z2'] }],
    expectedB: [{ from: 'c0', specifier: 'shortcut', to: 'c2', alternativePath: ['c0', 'c1', 'c2'] }],
    expectedUnion: [{ from: 'c0', specifier: 'shortcut', to: 'c2', alternativePath: ['c0', 'c1', 'c2'] }, { from: 'z0', specifier: 'shortcut', to: 'z2', alternativePath: ['z0', 'z1', 'z2'] }],
  },
  {
    name: 'parallel imports and lazy edge',
    a: report('d0', [{ path: 'd0', bytes: 37, eager: true }, { path: 'd1', bytes: 41, eager: true }], [edge('d0', 'd1', 'one'), edge('d0', 'd1', 'two')]),
    b: report('e0', [{ path: 'e0', bytes: 43, eager: true }, { path: 'e1', bytes: 47, eager: false }], [edge('e0', 'e1', 'later', 'lazy')]),
    expectedA: [{ from: 'd0', specifier: 'one', to: 'd1', alternativePath: ['d0', 'd1'] }, { from: 'd0', specifier: 'two', to: 'd1', alternativePath: ['d0', 'd1'] }],
    expectedB: [],
    expectedUnion: [{ from: 'd0', specifier: 'one', to: 'd1', alternativePath: ['d0', 'd1'] }, { from: 'd0', specifier: 'two', to: 'd1', alternativePath: ['d0', 'd1'] }],
  },
];

function check(value, expected) {
  const original = JSON.stringify(value);
  for (const input of [original, original, JSON.stringify({ ...value, modules: [...value.modules].reverse(), edges: [...value.edges].reverse() })]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, output(value.entry, expected));
  }
  assert.equal(JSON.stringify(value), original);
}

for (const fixture of cases) {
  test(`disjoint union: ${fixture.name}`, () => {
    const { a, b, expectedA, expectedB, expectedUnion } = fixture;
    const union = report(a.entry, [...a.modules, ...b.modules.map(mod => ({ ...mod, eager: false }))], [...a.edges, ...b.edges]);
    check(a, expectedA);
    check(b, expectedB);
    check(union, expectedUnion);
    for (const candidate of expectedUnion) {
      const component = a.modules.some(mod => mod.path === candidate.from) ? a : b;
      assert.ok(candidate.alternativePath.every(path => component.modules.some(mod => mod.path === path)));
    }
  });
}

test('unknown endpoint is rejected without disclosing the input', () => {
  const invalid = report('secret', [{ path: 'secret', bytes: 1, eager: true }], [edge('secret', 'missing')]);
  const result = run(JSON.stringify(invalid));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
