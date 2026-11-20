import { deepStrictEqual, equal, match, ok } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'import-report-fan-in.mjs');
const importBudget = join(here, 'import-budget.mjs');
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();

function runReport(report) {
  const dir = mkdtempSync(join(scratchRoot, 'fan-in-'));
  try {
    const input = join(dir, 'report.json');
    writeFileSync(input, JSON.stringify(report));
    return spawnSync(process.execPath, [cli, input], { encoding: 'utf8', timeout: 5000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edge(from, specifier, kind, to) {
  return { from, specifier, kind, to };
}

const graph = {
  entry: 'entry.mjs',
  modules: [
    { path: 'entry.mjs', bytes: 30, eager: true },
    { path: 'diamond.mjs', bytes: 20, eager: true },
    { path: 'shared.mjs', bytes: 50, eager: true },
    { path: 'zero.mjs', bytes: 40, eager: false },
    { path: 'lazy-only.mjs', bytes: 99, eager: false },
    { path: 'disconnected.mjs', bytes: 1000, eager: false },
  ],
  edges: [
    edge('entry.mjs', './diamond.mjs', 'eager', 'diamond.mjs'),
    edge('entry.mjs', './shared-a.mjs', 'eager', 'shared.mjs'),
    edge('entry.mjs', './shared-b.mjs', 'eager', 'shared.mjs'),
    edge('diamond.mjs', './shared.mjs', 'eager', 'shared.mjs'),
    edge('shared.mjs', './shared.mjs', 'eager', 'shared.mjs'),
    edge('entry.mjs', './lazy-only.mjs', 'lazy', 'lazy-only.mjs'),
    edge('entry.mjs', 'external', 'lazy', null),
    edge('disconnected.mjs', './entry.mjs', 'eager', 'entry.mjs'),
  ],
};

test('reports exact direct eager fan-in and is independent of input permutations', () => {
  const expected = {
    entry: 'entry.mjs',
    modules: [
      { path: 'shared.mjs', bytes: 50, importerCount: 2, importers: ['diamond.mjs', 'entry.mjs'] },
      { path: 'diamond.mjs', bytes: 20, importerCount: 1, importers: ['entry.mjs'] },
      { path: 'entry.mjs', bytes: 30, importerCount: 0, importers: [] },
    ],
  };
  const first = runReport(graph);
  equal(first.status, 0, first.stderr);
  equal(first.stderr, '');
  deepStrictEqual(JSON.parse(first.stdout), expected);

  const permuted = {
    entry: graph.entry,
    modules: [...graph.modules].reverse(),
    edges: [...graph.edges].reverse(),
  };
  const second = runReport(permuted);
  equal(second.status, 0, second.stderr);
  equal(second.stdout, first.stdout);
});

test('handles large eager fan-out without overflowing the call stack', () => {
  const edges = Array.from({ length: 150000 }, (_, index) => edge('root', String(index), 'eager', 'leaf'));
  const result = runReport({
    entry: 'root',
    modules: [{ path: 'root', bytes: 0, eager: true }, { path: 'leaf', bytes: 1, eager: true }],
    edges,
  });
  equal(result.status, 0, result.stderr);
  equal(result.stdout, JSON.stringify({ entry: 'root', modules: [
    { path: 'leaf', bytes: 1, importerCount: 1, importers: ['root'] },
    { path: 'root', bytes: 0, importerCount: 0, importers: [] },
  ] }) + '\n');
});

test('cycle and equal ranks use code-unit path order', () => {
  const result = runReport({
    entry: 'root',
    modules: [
      { path: 'root', bytes: 1, eager: true },
      { path: 'z', bytes: 5, eager: true },
      { path: 'A', bytes: 5, eager: true },
      { path: 'consumer', bytes: 1, eager: false },
    ],
    edges: [edge('root', 'z', 'eager', 'z'), edge('root', 'A', 'eager', 'A'),
      edge('z', 'root', 'eager', 'root'), edge('consumer', 'A', 'eager', 'A'),
      edge('root', 'consumer', 'lazy', 'consumer')],
  });
  equal(result.status, 0, result.stderr);
  equal(result.stdout, JSON.stringify({ entry: 'root', modules: [
    { path: 'A', bytes: 5, importerCount: 1, importers: ['root'] },
    { path: 'z', bytes: 5, importerCount: 1, importers: ['root'] },
    { path: 'root', bytes: 1, importerCount: 1, importers: ['z'] },
  ] }) + '\n');
});

test('accepts additional fields and preserves zero-importer entry only', () => {
  const report = runReport({
    ...graph,
    metadata: { source: 'fixture' },
    modules: graph.modules.map(module => ({ ...module, extra: true })),
    edges: graph.edges.map(item => ({ ...item, extra: true })),
  });
  equal(report.status, 0, report.stderr);
  equal(JSON.parse(report.stdout).modules.some(module => module.path === 'zero.mjs'), false);
});

test('rejects malformed reports without stdout or echoed input', () => {
  for (const invalid of [
    { entry: '', modules: [], edges: [] },
    { entry: 'entry.mjs', modules: [{ path: 'entry.mjs', bytes: 0, eager: false }], edges: [] },
    { entry: 'entry.mjs', modules: [{ path: 'entry.mjs', bytes: 0, eager: true }], edges: [edge('entry.mjs', './missing.mjs', 'eager', 'missing.mjs')] },
    { entry: 'entry.mjs', modules: [{ path: 'entry.mjs', bytes: 0, eager: true }], edges: [edge('entry.mjs', './x', 'eager', null), edge('entry.mjs', './x', 'eager', null)] },
  ]) {
    const result = runReport(invalid);
    equal(result.status, 1);
    equal(result.stdout, '');
    match(result.stderr, /^fan-in report: invalid input\n$/);
    ok(!result.stderr.includes('missing.mjs'));
  }
});

test('rejects invalid module, edge and graph shapes', () => {
  const base = { entry: 'root', modules: [{ path: 'root', bytes: 0, eager: true }], edges: [] };
  const module = (changes) => ({ ...base, modules: [{ ...base.modules[0], ...changes }] });
  const invalid = [
    null, [], {}, { ...base, modules: null }, { ...base, edges: {} },
    { ...base, entry: 'missing' },
    module({ path: '' }), module({ bytes: -1 }), module({ bytes: 1.5 }),
    module({ bytes: Number.MAX_SAFE_INTEGER + 1 }), module({ eager: 'true' }),
    { ...base, modules: [base.modules[0], base.modules[0]] },
    { ...base, modules: [null] },
    ...[null, {}, edge('', 'x', 'eager', null), edge('root', '', 'eager', null),
      edge('root', 'x', 'other', null), edge('root', 'x', 'eager', ''),
      edge('missing', 'x', 'eager', null), edge('root', 'x', 'lazy', 'missing')]
      .map(item => ({ ...base, edges: [item] })),
    { ...base, modules: [...base.modules, { path: 'other', bytes: 0, eager: true }] },
    { ...base, modules: [...base.modules, { path: 'other', bytes: 0, eager: false }],
      edges: [edge('root', 'other', 'eager', 'other')] },
  ];
  for (const input of invalid) {
    const result = runReport(input);
    equal(result.status, 1, JSON.stringify(input));
    equal(result.stdout, '');
    equal(result.stderr, 'fan-in report: invalid input\n');
  }
});

test('rejects argv, read, and JSON errors with stable category', () => {
  const noArg = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 5000 });
  equal(noArg.status, 1);
  equal(noArg.stdout, '');
  equal(noArg.stderr, 'fan-in report: invalid input\n');

  const missing = spawnSync(process.execPath, [cli, '/host/private/report.json'], { encoding: 'utf8', timeout: 5000 });
  equal(missing.status, 1);
  equal(missing.stdout, '');
  equal(missing.stderr, 'fan-in report: invalid input\n');

  const dir = mkdtempSync(join(scratchRoot, 'fan-in-json-'));
  try {
    const input = join(dir, 'bad.json');
    writeFileSync(input, '{not json');
    const badJson = spawnSync(process.execPath, [cli, input], { encoding: 'utf8', timeout: 5000 });
    equal(badJson.status, 1);
    equal(badJson.stdout, '');
    equal(badJson.stderr, 'fan-in report: invalid input\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('integrates with a real import-budget report', () => {
  const dir = mkdtempSync(join(scratchRoot, 'fan-in-budget-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), "import './a.mjs'; import './b.mjs';");
    writeFileSync(join(dir, 'a.mjs'), "export { value } from './shared.mjs';");
    writeFileSync(join(dir, 'b.mjs'), "export { value as other } from './shared.mjs';");
    writeFileSync(join(dir, 'shared.mjs'), 'export const value = 1;');
    const budget = spawnSync(process.execPath, [importBudget, join(dir, 'entry.mjs')], { encoding: 'utf8', timeout: 5000 });
    equal(budget.status, 0, budget.stderr);
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, budget.stdout);
    const fanIn = spawnSync(process.execPath, [cli, reportPath], { encoding: 'utf8', timeout: 5000 });
    equal(fanIn.status, 0, fanIn.stderr);
    deepStrictEqual(JSON.parse(fanIn.stdout).modules.map(module => module.path), ['shared.mjs', 'b.mjs', 'a.mjs', 'entry.mjs']);
    deepStrictEqual(JSON.parse(fanIn.stdout).modules[0].importers, ['a.mjs', 'b.mjs']);
    equal(readFileSync(reportPath, 'utf8'), budget.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
