import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const moduleRow = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = `literal:${from}->${to}`) => ({ from, to, kind, specifier });
const modules = [moduleRow('entry', 1), moduleRow('a', 2), moduleRow('b', 3), moduleRow('end', 5), moduleRow('off', 7, false)];
const fixtures = [
  { name: 'entry removal', removed: 'entry', edges: [edge('entry', 'a'), edge('a', 'end'), edge('entry', 'b', 'lazy'), edge('a', null)] },
  { name: 'diamond alternative', removed: 'a', edges: [edge('entry', 'a'), edge('entry', 'b'), edge('a', 'end'), edge('b', 'end'), edge('entry', null)] },
  { name: 'cycle', removed: 'a', edges: [edge('entry', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'end'), edge('entry', 'end', 'lazy')] },
  { name: 'disconnected removal', removed: 'off', edges: [edge('entry', 'a'), edge('a', 'end'), edge('off', 'b'), edge('entry', 'b', 'lazy'), edge('a', null)] },
].map(({ name, removed, edges }) => ({ name, removed, report: { entry: 'entry', modules, edges } }));
const maps = [
  new Map([['entry', 'root space'], ['a', 'z!'], ['b', '../b'], ['end', 'a?'], ['off', '\u96ea']]),
  new Map([['entry', '../\u03bb'], ['a', 'punct!'], ['b', 'with space'], ['end', '\u00e9'], ['off', 'off#']]),
];

// Fixed-point reachability scans the edge relation instead of building adjacency lists.
function reachable(report, removed) {
  const reached = new Set(report.entry === removed ? [] : [report.entry]);
  let changed;
  do {
    changed = false;
    for (const { from, to, kind } of report.edges) {
      if (kind === 'eager' && to !== null && to !== removed && reached.has(from) && !reached.has(to)) {
        reached.add(to);
        changed = true;
      }
    }
  } while (changed);
  return reached;
}
function expected(report, removed, map) {
  const baseline = reachable(report, null);
  const remaining = reachable(report, removed);
  const lost = report.modules.filter(({ path }) => baseline.has(path) && !remaining.has(path));
  return {
    entry: map.get(report.entry), removed: map.get(removed),
    lostPaths: lost.map(({ path }) => map.get(path)).sort(),
    lostBytes: lost.reduce((sum, row) => sum + row.bytes, 0),
  };
}
function rename(report, map) {
  return {
    ...report, entry: map.get(report.entry),
    modules: report.modules.map(row => ({ ...row, path: map.get(row.path) })),
    edges: report.edges.map(row => ({ ...row, from: map.get(row.from), to: row.to === null ? null : map.get(row.to) })),
  };
}
function run(report, removed) {
  return spawnSync(process.execPath, [cli, removed], { input: JSON.stringify(report), encoding: 'utf8', timeout: 10000 });
}
function assertSuccess(result, expectedOutput) {
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify(expectedOutput)}\n`);
}

test('cut impact survives bijections on mixed graphs', () => {
  const identity = new Map(modules.map(({ path }) => [path, path]));
  for (const { name, removed, report } of fixtures) {
    const baseline = expected(report, removed, identity);
    assertSuccess(run(report, removed), baseline);
    if (name === 'disconnected removal') assert.deepEqual([baseline.lostPaths, baseline.lostBytes], [[], 0]);
    for (const map of maps) {
      assert.equal(new Set(map.values()).size, modules.length);
      const transformed = expected(report, removed, map);
      assert.deepEqual(transformed.lostPaths, baseline.lostPaths.map(path => map.get(path)).sort());
      assert.equal(transformed.lostBytes, baseline.lostBytes);
      assertSuccess(run(rename(report, map), map.get(removed)), transformed);
    }
  }
  const entryLost = expected(fixtures[0].report, 'entry', identity).lostPaths;
  assert.notDeepEqual(entryLost.map(path => maps[0].get(path)), entryLost.map(path => maps[0].get(path)).sort());
});

test('assertion rejects corrupted output', () => {
  const { report, removed } = fixtures[0];
  const identity = new Map(modules.map(({ path }) => [path, path]));
  const result = run(report, removed);
  assertSuccess(result, expected(report, removed, identity));
  assert.throws(() => assertSuccess({ ...result, stdout: '{"entry":"wrong"}\n' }, expected(report, removed, identity)));
});

test('non-injective module identities fail safely', () => {
  const sentinel = 'synthetic-input-sentinel';
  const map = new Map(maps[0]);
  map.set('a', sentinel);
  map.set('b', sentinel);
  const result = run(rename(fixtures[1].report, map), sentinel);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes(sentinel));
});
