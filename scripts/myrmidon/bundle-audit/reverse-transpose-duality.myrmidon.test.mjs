import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const edge = (from, to, kind, specifier) => ({ from, to, kind, specifier });

// Traverse only eager internal edges; this oracle never reads CLI output.
function distances(edges, start) {
  const found = new Map([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const e of edges) {
      if (e.kind === 'eager' && e.from === queue[i] && e.to !== null && !found.has(e.to)) {
        found.set(e.to, found.get(queue[i]) + 1);
        queue.push(e.to);
      }
    }
  }
  return found;
}

function transpose(edges) {
  return edges.map(e => e.to === null ? { ...e } : { ...e, from: e.to, to: e.from });
}

function report(entry, paths, edges) {
  const reachable = distances(edges, entry);
  return { entry, modules: paths.map(path => ({ path, bytes: 1, eager: reachable.has(path) })), edges };
}

function expected(graph, target) {
  const found = distances(transpose(graph.edges), target);
  const importers = [...found].filter(([path]) => path !== target)
    .map(([path, distance]) => ({ path, distance }))
    .sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entry: graph.entry, target, importers };
}

function assertResult(actual, want) {
  // Compare the complete serialized JSON without exposing fixture data on failure.
  assert.ok(actual === `${JSON.stringify(want)}\n`, 'complete reverse-impact JSON differs from oracle');
}

const cases = [
  { name: 'asymmetric chain and disconnected importer', paths: ['entry', 'a', 'b', 't', 'other'], edges: [
    edge('entry', 'a', 'eager', 'entry-a'), edge('a', 'b', 'eager', 'a-b'),
    edge('b', 't', 'eager', 'b-t'), edge('other', 't', 'eager', 'other-t'),
    edge('entry', null, 'eager', 'external'),
  ] },
  { name: 'diamond with alias', paths: ['entry', 'a', 'b', 't'], edges: [
    edge('entry', 'a', 'eager', 'entry-a'), edge('entry', 'b', 'eager', 'entry-b'),
    edge('a', 't', 'eager', 'a-t'), edge('a', 't', 'eager', 'alias-a-t'), edge('b', 't', 'eager', 'b-t'),
  ] },
  { name: 'directed cycle and lazy bridge', paths: ['entry', 'a', 'b', 'c', 'isolated'], edges: [
    edge('entry', 'a', 'eager', 'entry-a'), edge('a', 'b', 'eager', 'a-b'),
    edge('b', 'c', 'eager', 'b-c'), edge('c', 'a', 'eager', 'c-a'),
    edge('c', 'isolated', 'lazy', 'c-isolated'), edge('isolated', 'entry', 'lazy', 'isolated-entry'),
  ] },
];

for (const fixture of cases) {
  test(`reverse impact equals transpose reachability: ${fixture.name}`, t => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'reverse-transpose-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const edges of [fixture.edges, transpose(fixture.edges)]) {
      const graph = report('entry', fixture.paths, edges);
      for (const target of fixture.paths) {
        const want = expected(graph, target);
        for (const value of [graph, { ...graph, modules: [...graph.modules].reverse(), edges: [...graph.edges].reverse() }]) {
          const input = JSON.stringify(value);
          const file = join(dir, 'report.json');
          writeFileSync(file, input);
          for (const source of [file, '-']) {
            const result = spawnSync(process.execPath, [cli, source, target], { input, encoding: 'utf8', timeout: 5000 });
            assert.equal(result.status, 0, 'CLI failed');
            assert.equal(result.stderr, '', 'CLI wrote to stderr');
            assertResult(result.stdout, want);
          }
        }
        if (want.importers.length) {
          const truncated = { ...want, importers: want.importers.slice(1) };
          assert.throws(() => assertResult(`${JSON.stringify(truncated)}\n`, want));
        }
      }
    }
  });
}
