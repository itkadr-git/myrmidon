import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = process.env.REVERSE_IMPACT_CLI || new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const run = (file, target) => spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 5000 });
const edge = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });

function fixture(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-distance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function eagerReachable(entry, edges) {
  const reachable = new Set([entry]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, to, kind } of edges) {
      if (kind === 'eager' && to !== null && reachable.has(from) && !reachable.has(to)) {
        reachable.add(to);
        changed = true;
      }
    }
  }
  return reachable;
}

function makeReport(entry, nodes, edges, disconnectedLazy = []) {
  const reachable = eagerReachable(entry, edges);
  const lazy = new Set(disconnectedLazy);
  return {
    entry,
    modules: nodes.map(path => ({ path, bytes: 1, eager: reachable.has(path) && !lazy.has(path) })),
    edges,
  };
}

// Enumerate forward simple paths independently of reverseImpact's reverse BFS.
function oracle(report, target) {
  const outgoing = new Map();
  for (const { from, to, kind } of report.edges) {
    if (kind !== 'eager' || to === null) continue;
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
  }
  const distances = new Map();
  for (const source of report.modules.map(({ path }) => path)) {
    const visit = (path, seen, distance) => {
      if (path === target) {
        if (source !== target && (!distances.has(source) || distance < distances.get(source))) distances.set(source, distance);
        return;
      }
      for (const next of outgoing.get(path) || []) {
        if (!seen.has(next)) visit(next, new Set([...seen, next]), distance + 1);
      }
    };
    visit(source, new Set([source]), 0);
  }
  return {
    entry: report.entry,
    target,
    importers: [...distances].map(([path, distance]) => ({ path, distance }))
      .sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

function assertOracle(t, report, target) {
  const dir = fixture(t);
  const file = join(dir, 'report.json');

  const permutations = [report, {
    ...report,
    modules: [...report.modules].reverse(),
    edges: [...report.edges].reverse(),
  }];
  for (const permutation of permutations) {
    writeFileSync(file, JSON.stringify(permutation));
    const before = readFileSync(file, 'utf8');
    const result = run(file, target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), oracle(report, target));
    assert.equal(readFileSync(file, 'utf8'), before);
  }
}

const cases = [
  ['chain', ['e', 'a', 'b', 'target'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'target')]],
  ['chain with target entry cycle', ['e', 'target', 'a', 'b'], [edge('e', 'target'), edge('target', 'a'), edge('a', 'b'), edge('b', 'target')]],
  ['diamond direct winner', ['e', 'a', 'b', 'target'], [edge('e', 'a'), edge('e', 'b'), edge('a', 'target'), edge('b', 'target')]],
  ['diamond unequal branches', ['e', 'a', 'long', 'b', 'target'], [edge('e', 'a'), edge('a', 'long'), edge('long', 'target'), edge('e', 'b'), edge('b', 'target')]],
  ['two long paths', ['e', 'a', 'b', 'x', 'y', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('e', 'b'), edge('b', 'x'), edge('x', 'y'), edge('y', 'target')]],
  ['shared tail', ['e', 'a', 'b', 'c', 'target'], [edge('e', 'a'), edge('e', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'target')]],
  ['upstream cycle', ['e', 'a', 'b', 'target'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'target')]],
  ['self loop importer', ['e', 'a', 'target'], [edge('e', 'a'), edge('a', 'a'), edge('a', 'target')]],
  ['self loop target', ['e', 'target'], [edge('e', 'target'), edge('target', 'target')]],
  ['back edge to entry', ['e', 'a', 'target'], [edge('e', 'a'), edge('a', 'e'), edge('a', 'target')]],
  ['multiple direct importers', ['e', 'a', 'b', 'target'], [edge('e', 'a'), edge('e', 'b'), edge('a', 'target'), edge('b', 'target')]],
  ['transitive and direct', ['e', 'a', 'b', 'target'], [edge('e', 'target'), edge('e', 'a'), edge('a', 'b'), edge('b', 'target')]],
  ['lazy shortcut ignored', ['e', 'a', 'b', 'target'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'target'), edge('e', 'target', 'lazy')]],
  ['lazy transitive branch ignored', ['e', 'a', 'lazy', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('e', 'lazy', 'lazy'), edge('lazy', 'target', 'lazy')]],
  ['lazy edge to eager target', ['e', 'a', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('e', 'target', 'lazy')]],
  ['disconnected lazy component', ['e', 'a', 'lazy', 'lazy-parent', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('lazy', 'target'), edge('lazy-parent', 'lazy')], ['lazy', 'lazy-parent']],
  ['disconnected lazy direct importer', ['e', 'target', 'lazy'], [edge('e', 'target'), edge('lazy', 'target')], ['lazy']],
  ['disconnected lazy cycle', ['e', 'a', 'lazy', 'other', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('lazy', 'other'), edge('other', 'lazy'), edge('other', 'target')], ['lazy', 'other']],
  ['disconnected lazy shortcut remains ignored', ['e', 'a', 'lazy', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('lazy', 'target', 'lazy'), edge('lazy', 'a')], ['lazy']],
  ['external eager edge ignored', ['e', 'a', 'target'], [edge('e', 'a'), edge('a', 'target'), edge('e', null)]],
  ['branch with cycle and shortcut', ['e', 'a', 'b', 'c', 'target'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('c', 'target'), edge('e', 'target')]],
  ['lexical path ordering', ['e', 'z', 'A', 'target'], [edge('e', 'z'), edge('e', 'A'), edge('z', 'target'), edge('A', 'target')]],
  ['unicode code-unit ordering', ['e', 'z', '\u00e9', 'target'], [edge('e', 'z'), edge('e', '\u00e9'), edge('z', 'target'), edge('\u00e9', 'target')]],
  ['deep cycle with two exits', ['e', 'a', 'b', 'c', 'd', 'target'], [edge('e', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd'), edge('d', 'target')]],
];

assert.ok(cases.length >= 24);
for (const [name, nodes, edges, disconnectedLazy] of cases) {
  test(`reverse distance oracle: ${name}`, t => {
    assertOracle(t, makeReport('e', nodes, edges, disconnectedLazy), 'target');
  });
}
