import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const run = report => spawnSync(process.execPath, [cli], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 5000,
});

// Enumerate simple vertex paths from the original relation, not import tuples.
function pathsFrom(entry, relations) {
  const paths = [[entry]];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    for (const [from, to, kind] of relations) {
      if (from === path.at(-1) && kind === 'eager' && to !== null && !path.includes(to)) {
        paths.push([...path, to]);
      }
    }
  }
  return paths;
}

function expectedFor(entry, names, relations) {
  const paths = pathsFrom(entry, relations);
  const modules = [], unreachable = [];
  for (const name of [...names].sort(compare)) {
    const matches = paths.filter(path => path.at(-1) === name);
    if (!matches.length) { unreachable.push(name); continue; }
    const length = Math.min(...matches.map(path => path.length));
    modules.push({ path: name, depth: length - 1, shortestPaths: String(matches.filter(path => path.length === length).length) });
  }
  return { entry, modules, unreachable };
}

function reportFor(fixture, multiplicity) {
  const reachable = new Set(pathsFrom(fixture.entry, fixture.relations).map(path => path.at(-1)));
  const modules = fixture.names.map((path, index) => ({ path, bytes: 17 + index * 11, eager: reachable.has(path) }));
  const edges = fixture.relations.flatMap(([from, to, kind], relation) =>
    Array.from({ length: to === null ? 1 : multiplicity }, (_, alias) => ({
      from, to, kind, specifier: `relation-${relation}-alias-${alias}`,
    })));
  return { entry: fixture.entry, modules, edges };
}

function assertOutput(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
}

const fixtures = [
  { name: 'chain', entry: 'entry', names: ['entry', 'a', 'b', 'end'], relations: [
    ['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'end', 'eager'],
  ] },
  { name: 'diamond with shared suffix', entry: 'entry', names: ['entry', 'a', 'b', 'join', 'end'], relations: [
    ['entry', 'a', 'eager'], ['entry', 'b', 'eager'], ['a', 'join', 'eager'],
    ['b', 'join', 'eager'], ['join', 'end', 'eager'],
  ] },
  { name: 'cycle with exit', entry: 'entry', names: ['entry', 'a', 'b', 'end'], relations: [
    ['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'a', 'eager'], ['b', 'end', 'eager'],
  ] },
  { name: 'mixed eager lazy null disconnected', entry: 'entry', names: ['entry', 'a', 'b', 'lazy', 'off', 'off2'], relations: [
    ['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['entry', 'b', 'lazy'],
    ['entry', 'lazy', 'lazy'], ['a', null, 'eager'], ['off', 'off2', 'eager'],
    ['off2', 'off', 'eager'],
  ] },
];

test('parallel specifiers preserve shortest vertex paths across permutations', () => {
  for (const fixture of fixtures) {
    const expected = expectedFor(fixture.entry, fixture.names, fixture.relations);
    assert.ok(expected.modules.length > 1);
    for (const multiplicity of [1, 2, 4]) {
      const report = reportFor(fixture, multiplicity);
      for (const reverse of [false, true]) {
        const input = reverse ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
        assertOutput(run(input), expected);
      }
    }
  }
  const diamond = expectedFor(fixtures[1].entry, fixtures[1].names, fixtures[1].relations);
  assert.deepEqual(diamond.modules.find(module => module.path === 'end'), { path: 'end', depth: 3, shortestPaths: '2' });
});

test('the same output assertion rejects a corrupted path count', () => {
  const fixture = fixtures[1];
  const expected = expectedFor(fixture.entry, fixture.names, fixture.relations);
  const result = run(reportFor(fixture, 4));
  assertOutput(result, expected);
  const corrupted = structuredClone(expected);
  corrupted.modules.find(module => module.path === 'end').shortestPaths = '3';
  assert.throws(() => assertOutput(result, corrupted), assert.AssertionError);
});

test('an exact duplicate import tuple is rejected, unlike parallel aliases', () => {
  const fixture = fixtures[0];
  const report = reportFor(fixture, 2);
  assertOutput(run(report), expectedFor(fixture.entry, fixture.names, fixture.relations));
  const duplicate = { ...report, edges: [...report.edges, { ...report.edges[0] }] };
  const result = run(duplicate);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.notEqual(result.stderr, '');
  assert.equal(result.stderr, 'graph\n');
});
