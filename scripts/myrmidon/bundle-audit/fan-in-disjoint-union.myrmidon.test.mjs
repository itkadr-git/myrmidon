import { equal, notEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-fan-in.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const edge = (from, to) => ({ from, specifier: `./${to}`, kind: 'eager', to });

// The expected reports are independent, hand-written oracles for each component.
const cases = [
  {
    a: { entry: 'a1', modules: [{ path: 'a1', bytes: 10, eager: true }, { path: 'a2', bytes: 20, eager: true }], edges: [edge('a1', 'a2')] },
    b: { entry: 'b1', modules: [{ path: 'b1', bytes: 30, eager: true }, { path: 'b2', bytes: 40, eager: true }], edges: [edge('b1', 'b2')] },
    expectedA: { entry: 'a1', modules: [{ path: 'a2', bytes: 20, importerCount: 1, importers: ['a1'] }, { path: 'a1', bytes: 10, importerCount: 0, importers: [] }] },
    expectedB: { entry: 'b1', modules: [{ path: 'b2', bytes: 40, importerCount: 1, importers: ['b1'] }, { path: 'b1', bytes: 30, importerCount: 0, importers: [] }] },
  },
  {
    a: { entry: 'c1', modules: [{ path: 'c1', bytes: 11, eager: true }, { path: 'c2', bytes: 13, eager: true }, { path: 'c3', bytes: 17, eager: true }], edges: [edge('c1', 'c2'), edge('c1', 'c3'), edge('c2', 'c3')] },
    b: { entry: 'd1', modules: [{ path: 'd1', bytes: 19, eager: true }, { path: 'd2', bytes: 23, eager: true }], edges: [edge('d1', 'd2'), edge('d2', 'd1')] },
    expectedA: { entry: 'c1', modules: [{ path: 'c3', bytes: 17, importerCount: 2, importers: ['c1', 'c2'] }, { path: 'c2', bytes: 13, importerCount: 1, importers: ['c1'] }, { path: 'c1', bytes: 11, importerCount: 0, importers: [] }] },
    expectedB: { entry: 'd1', modules: [{ path: 'd2', bytes: 23, importerCount: 1, importers: ['d1'] }, { path: 'd1', bytes: 19, importerCount: 1, importers: ['d2'] }] },
  },
  {
    a: { entry: 'e1', modules: [{ path: 'e1', bytes: 31, eager: true }], edges: [] },
    b: { entry: 'f1', modules: [{ path: 'f1', bytes: 37, eager: true }, { path: 'f2', bytes: 41, eager: true }, { path: 'f3', bytes: 43, eager: true }], edges: [edge('f1', 'f2'), edge('f1', 'f3'), edge('f2', 'f3')] },
    expectedA: { entry: 'e1', modules: [{ path: 'e1', bytes: 31, importerCount: 0, importers: [] }] },
    expectedB: { entry: 'f1', modules: [{ path: 'f3', bytes: 43, importerCount: 2, importers: ['f1', 'f2'] }, { path: 'f2', bytes: 41, importerCount: 1, importers: ['f1'] }, { path: 'f1', bytes: 37, importerCount: 0, importers: [] }] },
  },
];

function run(input, expected) {
  const dir = mkdtempSync(join(scratch, 'fan-in-union-'));
  try {
    const path = join(dir, 'report.json');
    const original = JSON.stringify(input);
    writeFileSync(path, original);
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 5000 });
    equal(readFileSync(path, 'utf8'), original);
    if (expected === null) {
      notEqual(result.status, 0);
      equal(result.stdout, '');
      equal(result.stderr, 'fan-in report: invalid input\n');
    } else {
      equal(result.status, 0, result.stderr);
      equal(result.stderr, '');
      equal(result.stdout, JSON.stringify(expected) + '\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [index, { a, b, expectedA, expectedB }] of cases.entries()) {
  test(`disjoint union isolates both eager closures, case ${index + 1}`, () => {
    run(a, expectedA);
    run(b, expectedB);
    for (const [active, inactive, expected] of [[a, b, expectedA], [b, a, expectedB]]) {
      const union = {
        entry: active.entry,
        modules: [...active.modules, ...inactive.modules.map(module => ({ ...module, eager: false }))],
        edges: [...active.edges, ...inactive.edges],
      };
      run(union, expected);
      run(union, expected);
      run({ ...union, modules: [...union.modules].reverse(), edges: [...union.edges].reverse() }, expected);
    }
  });
}

test('rejects a disjoint union with a missing edge endpoint', () => {
  const { a, b } = cases[0];
  run({ entry: a.entry, modules: [...a.modules, ...b.modules.map(module => ({ ...module, eager: false }))],
    edges: [...a.edges, ...b.edges, edge('b1', 'missing-private-endpoint')] }, null);
});
