import { deepStrictEqual, equal, notEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-fan-in.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const moduleRow = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });

function runReport(graph) {
  const dir = mkdtempSync(join(scratch, 'fan-in-subdivision-'));
  try {
    const input = join(dir, 'report.json');
    writeFileSync(input, JSON.stringify(graph));
    return spawnSync(process.execPath, [cli, input], { encoding: 'utf8', timeout: 5000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(graph, expected) {
  const original = JSON.stringify(graph);
  const reversed = { ...graph, modules: [...graph.modules].reverse(), edges: [...graph.edges].reverse() };
  for (const input of [graph, graph, reversed]) {
    const result = runReport(input);
    equal(result.status, 0, result.stderr);
    equal(result.stderr, '');
    deepStrictEqual(JSON.parse(result.stdout), expected);
    equal(result.stdout, JSON.stringify(expected) + '\n');
  }
  equal(JSON.stringify(graph), original);
}

test('subdividing an eager edge transfers the direct importer', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 3, true)],
    edges: [edge('u', './v', 'eager', 'v')] };
  const transformed = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 3, true), moduleRow('x', 2, true)],
    edges: [edge('u', './x', 'eager', 'x'), edge('x', './v', 'eager', 'v')] };
  check(baseline, { entry: 'u', modules: [
    { path: 'v', bytes: 3, importerCount: 1, importers: ['u'] },
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
  check(transformed, { entry: 'u', modules: [
    { path: 'v', bytes: 3, importerCount: 1, importers: ['x'] },
    { path: 'x', bytes: 2, importerCount: 1, importers: ['u'] },
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
});

test('diamond subdivision retains a second direct specifier and exact ranks', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 4, true), moduleRow('w', 3, true)],
    edges: [edge('u', './v-one', 'eager', 'v'), edge('u', './v-two', 'eager', 'v'), edge('u', './w', 'eager', 'w'), edge('w', './v', 'eager', 'v')] };
  const transformed = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 4, true), moduleRow('w', 3, true), moduleRow('x', 2, true)],
    edges: [edge('u', './x', 'eager', 'x'), edge('x', './v', 'eager', 'v'), edge('u', './v-two', 'eager', 'v'), edge('u', './w', 'eager', 'w'), edge('w', './v', 'eager', 'v')] };
  check(baseline, { entry: 'u', modules: [
    { path: 'v', bytes: 4, importerCount: 2, importers: ['u', 'w'] },
    { path: 'w', bytes: 3, importerCount: 1, importers: ['u'] },
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
  check(transformed, { entry: 'u', modules: [
    { path: 'v', bytes: 4, importerCount: 3, importers: ['u', 'w', 'x'] },
    { path: 'w', bytes: 3, importerCount: 1, importers: ['u'] },
    { path: 'x', bytes: 2, importerCount: 1, importers: ['u'] },
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
});

test('a lazy-only subdivision does not add startup rows', () => {
  const baseline = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 3, false)],
    edges: [edge('u', './v', 'lazy', 'v')] };
  const transformed = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 3, false), moduleRow('x', 2, false)],
    edges: [edge('u', './x', 'lazy', 'x'), edge('x', './v', 'eager', 'v')] };
  check(baseline, { entry: 'u', modules: [
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
  check(transformed, { entry: 'u', modules: [
    { path: 'u', bytes: 1, importerCount: 0, importers: [] },
  ] });
});

test('rejects subdivision with a missing intermediate endpoint', () => {
  const invalid = { entry: 'u', modules: [moduleRow('u', 1, true), moduleRow('v', 3, true)],
    edges: [edge('u', './x', 'eager', 'x'), edge('x', './v', 'eager', 'v')] };
  const result = runReport(invalid);
  notEqual(result.status, 0);
  equal(result.stdout, '');
  equal(result.stderr, 'fan-in report: invalid input\n');
});
