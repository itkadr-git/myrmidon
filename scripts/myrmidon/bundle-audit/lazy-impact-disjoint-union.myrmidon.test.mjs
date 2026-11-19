import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-lazy-impact.mjs', import.meta.url));
const m = (path, bytes) => ({ path, bytes, eager: true });
const e = (from, specifier, to) => ({ from, specifier, kind: 'eager', to });

// The expected totals and removed paths are specified independently of the CLI.
const cases = [
  {
    a: { entry: 'a0', modules: [m('a0', 10), m('a1', 20)], edges: [e('a0', 'one', 'a1')] },
    b: { entry: 'b0', modules: [m('b0', 3), m('b1', 7)], edges: [e('b0', 'one', 'b1')] },
    aResult: { entry: 'a0', selected: { from: 'a0', specifier: 'one', to: 'a1' }, before: { modules: 2, bytes: 30 }, after: { modules: 1, bytes: 10 }, removedPaths: ['a1'], savedBytes: 20 },
    bResult: { entry: 'b0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 2, bytes: 10 }, after: { modules: 1, bytes: 3 }, removedPaths: ['b1'], savedBytes: 7 },
    unreachable: { entry: 'a0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 2, bytes: 30 }, after: { modules: 2, bytes: 30 }, removedPaths: [], savedBytes: 0 },
  },
  {
    a: { entry: 'a0', modules: [m('a0', 2), m('a1', 5), m('a2', 11)], edges: [e('a0', 'one', 'a1'), e('a1', 'two', 'a2')] },
    b: { entry: 'b0', modules: [m('b0', 13), m('b1', 17), m('b2', 19)], edges: [e('b0', 'one', 'b1'), e('b1', 'two', 'b2')] },
    aResult: { entry: 'a0', selected: { from: 'a0', specifier: 'one', to: 'a1' }, before: { modules: 3, bytes: 18 }, after: { modules: 1, bytes: 2 }, removedPaths: ['a1', 'a2'], savedBytes: 16 },
    bResult: { entry: 'b0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 3, bytes: 49 }, after: { modules: 1, bytes: 13 }, removedPaths: ['b1', 'b2'], savedBytes: 36 },
    unreachable: { entry: 'a0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 3, bytes: 18 }, after: { modules: 3, bytes: 18 }, removedPaths: [], savedBytes: 0 },
  },
  {
    a: { entry: 'a0', modules: [m('a0', 4), m('a1', 6), m('a2', 9)], edges: [e('a0', 'one', 'a1'), e('a0', 'two', 'a2'), e('a2', 'shared', 'a1')] },
    b: { entry: 'b0', modules: [m('b0', 8), m('b1', 12), m('b2', 15)], edges: [e('b0', 'one', 'b1'), e('b0', 'two', 'b2')] },
    aResult: { entry: 'a0', selected: { from: 'a0', specifier: 'one', to: 'a1' }, before: { modules: 3, bytes: 19 }, after: { modules: 3, bytes: 19 }, removedPaths: [], savedBytes: 0 },
    bResult: { entry: 'b0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 3, bytes: 35 }, after: { modules: 2, bytes: 23 }, removedPaths: ['b1'], savedBytes: 12 },
    unreachable: { entry: 'a0', selected: { from: 'b0', specifier: 'one', to: 'b1' }, before: { modules: 3, bytes: 19 }, after: { modules: 3, bytes: 19 }, removedPaths: [], savedBytes: 0 },
  },
];

function union(active, inactive) {
  return { entry: active.entry, modules: [...active.modules, ...inactive.modules.map(mod => ({ ...mod, eager: false }))], edges: [...active.edges, ...inactive.edges] };
}

function run(dir, report, from, expected) {
  const file = join(dir, 'report.json');
  const input = JSON.stringify(report);
  writeFileSync(file, input);
  const result = spawnSync(process.execPath, [cli, file, from, 'one'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readFileSync(file, 'utf8'), input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

test('disjoint graphs preserve each startup closure under selection, reroot and permutation', () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'disjoint-'));
  try {
    for (const { a, b, aResult, bResult, unreachable } of cases) {
      const ab = union(a, b), ba = union(b, a);
      for (let repeat = 0; repeat < 2; repeat++) {
        run(dir, a, 'a0', aResult);
        run(dir, b, 'b0', bResult);
        run(dir, ab, 'a0', aResult);
        run(dir, ab, 'b0', unreachable);
        run(dir, ba, 'b0', bResult);
        for (const report of [a, b, ab, ba]) { report.modules.reverse(); report.edges.reverse(); }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing endpoint reports a sanitized graph error without modifying input', () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'lazy-impact-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'disjoint-invalid-'));
  try {
    const report = union(cases[0].a, cases[0].b);
    report.edges.push(e('b0', 'bad', 'missing'));
    const file = join(dir, 'report.json'), input = JSON.stringify(report);
    writeFileSync(file, input);
    const result = spawnSync(process.execPath, [cli, file, 'a0', 'one'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'error: graph\n');
    assert.equal(readFileSync(file, 'utf8'), input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
