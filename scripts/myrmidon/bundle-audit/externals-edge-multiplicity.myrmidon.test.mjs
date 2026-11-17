import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const run = report => spawnSync(process.execPath, [cli, '-'], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
const assertOutput = (result, expected) => {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stdout, `${JSON.stringify(expected)}\n`);
};

// Group only unresolved tuples, independently of the CLI's implementation.
function oracle(report) {
  const rows = { externals: [], unresolvedLocal: [] };
  const unresolved = report.edges.filter(edge => edge.to === null);
  for (const specifier of [...new Set(unresolved.map(edge => edge.specifier))].sort(compare)) {
    const matching = unresolved.filter(edge => edge.specifier === specifier);
    const importers = kind => [...new Set(matching.filter(edge => edge.kind === kind).map(edge => edge.from))].sort(compare);
    const row = { specifier, eagerImporters: importers('eager'), lazyImporters: importers('lazy') };
    const local = specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:/.test(specifier);
    rows[local ? 'unresolvedLocal' : 'externals'].push(row);
  }
  return { entry: report.entry, ...rows };
}

const graphs = {
  chain: [['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'c', 'eager']],
  diamond: [['entry', 'a', 'eager'], ['entry', 'b', 'eager'], ['a', 'c', 'eager'], ['b', 'c', 'eager'], ['c', 'd', 'eager']],
  cycle: [['entry', 'a', 'eager'], ['a', 'b', 'eager'], ['b', 'a', 'eager'], ['b', 'c', 'eager']],
  mixed: [['entry', 'a', 'eager'], ['a', 'b', 'lazy'], ['b', 'c', 'eager'], ['entry', 'd', 'lazy'], ['isolated', 'c', 'eager']],
};

function fixture(relations, aliases) {
  const paths = [...new Set(['entry', 'isolated', ...relations.flatMap(([from, to]) => [from, to])])];
  const reachable = new Set(['entry']);
  let size;
  do {
    size = reachable.size;
    for (const [from, to, kind] of relations) if (kind === 'eager' && reachable.has(from)) reachable.add(to);
  } while (size !== reachable.size);
  const modules = paths.map((path, index) => ({ path, bytes: (index + 1) * 17, eager: reachable.has(path) }));
  const edges = relations.flatMap(([from, to, kind], index) => Array.from({ length: aliases }, (_, alias) => ({ from, to, kind, specifier: `resolved-${index}-${alias}` })));
  edges.push(
    { from: 'entry', to: null, kind: 'eager', specifier: 'pkg' },
    { from: 'a', to: null, kind: 'eager', specifier: 'pkg' },
    { from: 'a', to: null, kind: 'lazy', specifier: 'pkg' },
    { from: 'isolated', to: null, kind: 'lazy', specifier: 'pkg/sub' },
    { from: 'entry', to: null, kind: 'eager', specifier: './missing' },
    { from: 'a', to: null, kind: 'lazy', specifier: './missing' },
    { from: 'isolated', to: null, kind: 'eager', specifier: './missing/other' },
  );
  return { entry: 'entry', modules, edges };
}

test('inventory is independent of resolved alias multiplicity and input order', async t => {
  for (const [name, relations] of Object.entries(graphs)) {
    await t.test(name, () => {
      const baseline = fixture(relations, 1);
      const expected = oracle(baseline);
      assert.ok(expected.externals.length && expected.unresolvedLocal.length);
      for (const count of [1, 2, 4]) {
        const report = fixture(relations, count);
        assert.deepEqual(report.modules, baseline.modules);
        assert.deepEqual(oracle(report), expected);
        for (const reverse of [false, true]) {
          const input = reverse ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
          assertOutput(run(input), expected);
        }
      }
    });
  }
});

test('new unresolved specifiers and importer kinds appear in the correct sets', () => {
  const report = fixture(graphs.mixed, 4);
  report.edges.push(
    { from: 'b', to: null, kind: 'eager', specifier: 'pkg' },
    { from: 'entry', to: null, kind: 'lazy', specifier: './missing' },
    { from: 'b', to: null, kind: 'lazy', specifier: 'pkg/new' },
    { from: 'd', to: null, kind: 'eager', specifier: './missing/new' },
  );
  assertOutput(run(report), oracle(report));
});

test('exact duplicate tuple fails without partial output, unlike aliases', () => {
  const report = fixture(graphs.diamond, 2);
  assertOutput(run(report), oracle(report));
  for (const edge of [report.edges[0], report.edges.find(edge => edge.to === null)]) {
    const result = run({ ...report, edges: [...report.edges, { ...edge }] });
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr, '');
    assert.equal(result.stdout, '');
  }
});

test('assertion helper rejects a corrupted expected importer', () => {
  const report = fixture(graphs.chain, 1);
  const expected = oracle(report);
  const corrupted = structuredClone(expected);
  corrupted.externals[0].eagerImporters.push('not-an-importer');
  assert.throws(() => assertOutput(run(report), corrupted), assert.AssertionError);
});
