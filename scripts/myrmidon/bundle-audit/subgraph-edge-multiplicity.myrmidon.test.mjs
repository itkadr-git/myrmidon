import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-subgraph.mjs', import.meta.url));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Fixed-point reachability is deliberately independent of the CLI's traversal.
function reachable(root, edges, all) {
  const seen = new Set([root]);
  let size;
  do {
    size = seen.size;
    for (const edge of edges) {
      if (seen.has(edge.from) && edge.to !== null && (all || edge.kind === 'eager')) seen.add(edge.to);
    }
  } while (size !== seen.size);
  return seen;
}

function makeReport(nodes, relations, count) {
  const edges = relations.flatMap(([from, to, kind], index) =>
    Array.from({ length: to === null ? 1 : count }, (_, alias) => ({
      from, specifier: `spec-${index}-${alias}`, kind, to,
    })));
  const eager = reachable('entry', edges, false);
  return {
    entry: 'entry',
    modules: nodes.map((path, index) => ({ path, bytes: (index + 1) * 13, eager: eager.has(path) })),
    edges,
  };
}

function expectedProjection(report, root, mode) {
  const reached = reachable(root, report.edges, mode === 'all');
  const modules = report.modules.filter(m => reached.has(m.path)).sort((a, b) => compare(a.path, b.path));
  const edges = report.edges.filter(e => reached.has(e.from) && (mode === 'all' || e.kind === 'eager'));
  edges.sort((a, b) => {
    for (const key of ['from', 'specifier', 'kind', 'to']) {
      if (a[key] === b[key]) continue;
      if (a[key] === null) return -1;
      if (b[key] === null) return 1;
      return compare(a[key], b[key]);
    }
    return 0;
  });
  return { root, mode, modules, edges, unknown: edges.filter(e => e.to === null) };
}

function run(report, root, mode) {
  return spawnSync(process.execPath, [cli, '-', root, mode], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
  });
}

function assertProjection(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

const fixtures = [
  { name: 'chain', nodes: ['entry', 'root', 'Z', 'end'], relations: [['entry', 'root', 'eager'], ['root', 'Z', 'eager'], ['Z', 'end', 'eager']] },
  { name: 'diamond shared suffix', nodes: ['entry', 'root', 'A', 'b', 'join', 'end'], relations: [['entry', 'root', 'eager'], ['root', 'A', 'eager'], ['root', 'b', 'eager'], ['A', 'join', 'eager'], ['b', 'join', 'eager'], ['join', 'end', 'eager']] },
  { name: 'cycle with exit', nodes: ['entry', 'root', 'loop', 'exit'], relations: [['entry', 'root', 'eager'], ['root', 'loop', 'eager'], ['loop', 'root', 'eager'], ['loop', 'exit', 'eager']] },
  { name: 'mixed and disconnected', nodes: ['entry', 'root', 'eager', 'lazy', 'tail', 'isolated'], relations: [['entry', 'root', 'lazy'], ['root', 'eager', 'eager'], ['root', 'lazy', 'lazy'], ['eager', null, 'eager'], ['eager', null, 'eager'], ['lazy', null, 'lazy'], ['lazy', 'tail', 'eager'], ['isolated', null, 'eager']] },
];

test('projection preserves parallel import tuples across graph shapes and permutations', async t => {
  for (const fixture of fixtures) {
    for (const count of [1, 2, 4]) {
      await t.test(`${fixture.name}: ${count} aliases`, () => {
        const report = makeReport(fixture.nodes, fixture.relations, count);
        for (const root of ['entry', 'root']) {
          for (const mode of ['eager', 'all']) {
            const expected = expectedProjection(report, root, mode);
            for (const reversed of [false, true]) {
              const input = reversed ? { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() } : report;
              const result = run(input, root, mode);
              assertProjection(result, expected);
              if (root === 'root' && mode === 'all' && !reversed) {
                assert.ok(expected.edges.length > 0);
                const corrupted = structuredClone(expected);
                corrupted.modules[0].bytes++;
                assert.throws(() => assertProjection(result, corrupted), assert.AssertionError);
              }
            }
          }
        }
      });
    }
  }
});

test('exact duplicate tuple is rejected without stdout', () => {
  const report = makeReport(fixtures[0].nodes, fixtures[0].relations, 2);
  report.edges.push({ ...report.edges[0] });
  for (const mode of ['eager', 'all']) {
    const result = run(report, 'root', mode);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\S/);
  }
});
