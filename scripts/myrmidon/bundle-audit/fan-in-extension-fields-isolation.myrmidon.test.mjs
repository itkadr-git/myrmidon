import { equal, notEqual, ok } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-fan-in.mjs');
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const sentinel = 'synthetic-extension-sentinel';
const extensions = JSON.parse('{"x_meta":{"path":"fake","from":"fake","to":"fake","bytes":-1,"eager":false,"nested":[null,true,"synthetic-extension-sentinel"]},"x_note":[false,null,{"eager":true}],"x_weight":"synthetic-extension-sentinel","__proto__":{"path":"fake"}}');

const cases = [
  {
    graph: {
      entry: 'root',
      modules: [
        { path: 'root', bytes: 10, eager: true },
        { path: 'a', bytes: 20, eager: true },
        { path: 'b', bytes: 30, eager: true },
        { path: 'unused', bytes: 99, eager: false },
      ],
      edges: [
        { from: 'root', specifier: 'a', kind: 'eager', to: 'a' },
        { from: 'root', specifier: 'b', kind: 'eager', to: 'b' },
        { from: 'a', specifier: 'b', kind: 'eager', to: 'b' },
        { from: 'root', specifier: 'unused', kind: 'lazy', to: 'unused' },
      ],
    },
    expected: { entry: 'root', modules: [
      { path: 'b', bytes: 30, importerCount: 2, importers: ['a', 'root'] },
      { path: 'a', bytes: 20, importerCount: 1, importers: ['root'] },
      { path: 'root', bytes: 10, importerCount: 0, importers: [] },
    ] },
  },
  {
    graph: {
      entry: 'entry',
      modules: [
        { path: 'entry', bytes: 3, eager: true },
        { path: 'z', bytes: 5, eager: true },
        { path: 'A', bytes: 5, eager: true },
        { path: 'zero', bytes: 40, eager: false },
      ],
      edges: [
        { from: 'entry', specifier: 'z', kind: 'eager', to: 'z' },
        { from: 'entry', specifier: 'A', kind: 'eager', to: 'A' },
        { from: 'z', specifier: 'entry', kind: 'eager', to: 'entry' },
        { from: 'A', specifier: 'self', kind: 'eager', to: 'A' },
        { from: 'entry', specifier: 'external', kind: 'lazy', to: null },
      ],
    },
    expected: { entry: 'entry', modules: [
      { path: 'A', bytes: 5, importerCount: 1, importers: ['entry'] },
      { path: 'z', bytes: 5, importerCount: 1, importers: ['entry'] },
      { path: 'entry', bytes: 3, importerCount: 1, importers: ['z'] },
    ] },
  },
];

function decorate(graph, report, modules, edges) {
  return {
    ...graph,
    ...(report ? extensions : {}),
    modules: graph.modules.map(item => modules ? { ...item, ...extensions } : { ...item }),
    edges: graph.edges.map(item => edges ? { ...item, ...extensions } : { ...item }),
  };
}

function run(input) {
  const dir = mkdtempSync(join(scratch, 'fan-in-extension-'));
  try {
    const file = join(dir, 'report.json');
    const fixture = JSON.stringify(input);
    writeFileSync(file, fixture);
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 5000 });
    equal(readFileSync(file, 'utf8'), fixture, 'CLI must not modify input');
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('extension fields do not affect the complete fan-in report', () => {
  for (const { graph, expected } of cases) {
    const snapshot = JSON.stringify(graph);
    const combined = decorate(graph, true, true, true);
    const variants = [
      graph, decorate(graph, true, false, false), decorate(graph, false, true, false),
      decorate(graph, false, false, true), combined,
      { ...combined, modules: [...combined.modules].reverse(), edges: [...combined.edges].reverse() },
      combined,
    ];
    for (const variant of variants) {
      const before = JSON.stringify(variant);
      const result = run(variant);
      equal(result.status, 0, result.stderr);
      equal(result.stderr, '');
      equal(result.stdout, JSON.stringify(expected) + '\n');
      ok(!result.stdout.includes(sentinel));
      equal(JSON.stringify(variant), before);
    }
    equal(JSON.stringify(graph), snapshot);
  }
});

test('decorated reports still reject invalid known fields without leaking input', () => {
  for (const { graph } of cases) {
    const decorated = decorate(graph, true, true, true);
    const invalidBytes = structuredClone(decorated);
    invalidBytes.modules[0].bytes = -1;
    const invalidEndpoint = structuredClone(decorated);
    invalidEndpoint.edges[0].to = 'private-missing-endpoint';
    for (const invalid of [invalidBytes, invalidEndpoint]) {
      const result = run(invalid);
      notEqual(result.status, 0);
      equal(result.stdout, '');
      equal(result.stderr, 'fan-in report: invalid input\n');
      ok(!result.stderr.includes(sentinel));
      ok(!result.stderr.includes('private-missing-endpoint'));
      ok(!result.stderr.includes(JSON.stringify(invalid)));
    }
  }
});
