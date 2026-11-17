import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || join(process.env.HOME, '.cache');
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Mutual reachability is deliberately independent of the CLI's SCC traversal.
function oracle(report, eagerOnly) {
  const paths = report.modules.map(m => m.path).sort(cmp);
  const reachable = start => {
    const seen = new Set([start]), pending = [start];
    while (pending.length) {
      const from = pending.pop();
      for (const e of report.edges) {
        if (e.from === from && e.to !== null && (!eagerOnly || e.kind === 'eager') && !seen.has(e.to)) {
          seen.add(e.to); pending.push(e.to);
        }
      }
    }
    return seen;
  };
  const reach = new Map(paths.map(path => [path, reachable(path)]));
  const remaining = new Set(paths), result = [];
  for (const path of paths) {
    if (!remaining.has(path)) continue;
    const component = paths.filter(other => remaining.has(other) && reach.get(path).has(other) && reach.get(other).has(path));
    for (const member of component) remaining.delete(member);
    if (component.length > 1 || report.edges.some(e => e.from === path && e.to === path && (!eagerOnly || e.kind === 'eager'))) result.push(component);
  }
  return result;
}

function transpose(report) {
  return { ...report, modules: report.modules.map(m => ({ ...m })), edges: report.edges.map(e => e.to === null ? { ...e } : { ...e, from: e.to, to: e.from }) };
}
function permute(report) {
  return { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
}
function assertCycles(actual, expected) {
  assert.deepEqual(actual, expected);
}
function run(t, report, stdin) {
  const input = JSON.stringify(report);
  let arg = '-';
  if (!stdin) {
    const dir = mkdtempSync(join(root, 'cycles-transpose-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    arg = join(dir, 'report.json'); writeFileSync(arg, input);
  }
  const result = spawnSync(process.execPath, [cli, arg], { encoding: 'utf8', input: stdin ? input : undefined, timeout: 10000 });
  assert.equal(result.status, 0, 'CLI must succeed');
  assert.equal(result.stderr, '', 'CLI must not emit diagnostics');
  return JSON.parse(result.stdout);
}

test('transposing internal edges preserves exact eager and all cycle components', t => {
  const paths = ['z', 'a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const tuples = [
    ['z', 'a', 'eager'], ['a', 'z', 'lazy'],
    ['b', 'C', 'eager'], ['C', 'b', 'eager'],
    ['d', 'd', 'eager'], ['e', 'f', 'eager'], ['f', 'e', 'eager'],
    ['g', 'h', 'eager'], ['h', 'i', 'lazy'], ['g', 'i', 'eager'],
    ['j', null, 'lazy'],
  ];
  const report = {
    entry: 'z',
    modules: paths.map((path, index) => ({ path, bytes: index + 1, eager: false })),
    edges: tuples.map(([from, to, kind], index) => ({ from, to, kind, specifier: `edge-${index}` })),
  };
  const expected = { entry: 'z', eagerCycles: [['C', 'b'], ['d'], ['e', 'f']], allCycles: [['C', 'b'], ['a', 'z'], ['d'], ['e', 'f']] };
  const incomplete = structuredClone(expected); incomplete.allCycles.pop();
  assert.throws(() => assertCycles(incomplete, expected), assert.AssertionError);
  for (const candidate of [report, permute(report), transpose(report), permute(transpose(report))]) {
    const independent = { entry: candidate.entry, eagerCycles: oracle(candidate, true), allCycles: oracle(candidate, false) };
    assertCycles(independent, expected);
    for (const stdin of [false, true]) assertCycles(run(t, candidate, stdin), expected);
  }
});

test('a different graph rejects a constant cycle report across transposition and ordering', t => {
  const paths = ['p', 'q', 'r', 's', 't', 'u'];
  const tuples = [
    ['p', 'q', 'eager'], ['q', 'p', 'eager'],
    ['r', 's', 'eager'], ['s', 't', 'lazy'], ['t', 'r', 'eager'],
    ['u', null, 'lazy'],
  ];
  const report = {
    entry: 'p',
    modules: paths.map((path, index) => ({ path, bytes: index + 1, eager: false })),
    edges: tuples.map(([from, to, kind], index) => ({ from, to, kind, specifier: `second-edge-${index}` })),
  };
  const expected = { entry: 'p', eagerCycles: [['p', 'q']], allCycles: [['p', 'q'], ['r', 's', 't']] };
  const constant = { entry: 'z', eagerCycles: [['C', 'b'], ['d'], ['e', 'f']], allCycles: [['C', 'b'], ['a', 'z'], ['d'], ['e', 'f']] };
  assert.throws(() => assertCycles(constant, expected), assert.AssertionError);
  const incomplete = structuredClone(expected); incomplete.allCycles.pop();
  assert.throws(() => assertCycles(incomplete, expected), assert.AssertionError);
  for (const candidate of [report, permute(report), transpose(report), permute(transpose(report))]) {
    assertCycles({ entry: candidate.entry, eagerCycles: oracle(candidate, true), allCycles: oracle(candidate, false) }, expected);
    for (const stdin of [false, true]) assertCycles(run(t, candidate, stdin), expected);
  }
});
