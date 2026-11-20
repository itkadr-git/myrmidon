import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-validate.mjs', import.meta.url));
const edge = (from, specifier, kind, to = null) => ({ from, specifier, kind, to });

function fixture() {
  const modules = [
    { path: 'entry', bytes: 9, eager: true },
    { path: '__proto__', bytes: 7, eager: true },
    { path: 'constructor', bytes: 5, eager: true },
    { path: 'space \u96ea|:', bytes: 3, eager: true },
  ];
  const unknown = [
    edge('entry', 'shared', 'eager'), edge('entry', 'shared', 'lazy'),
    edge('__proto__', 'constructor', 'eager'), edge('constructor', '__proto__', 'lazy'),
    edge('space \u96ea|:', 'x | : \u96ea', 'eager'),
    edge('entry', 'space \u96ea|:|x', 'lazy'),
  ];
  const resolved = [edge('entry', './proto', 'eager', '__proto__'),
    edge('__proto__', './constructor', 'eager', 'constructor'),
    edge('constructor', './space', 'eager', 'space \u96ea|:')];
  return { entry: 'entry', modules, edges: [...resolved, ...unknown.map(e => ({ ...e }))],
    unknown: unknown.map(e => ({ ...e })), counts: { modules: 4, eagerModules: 4, edges: 9 },
    bytes: { total: 24, eager: 24 }, heaviestEager: modules.map(m => ({ ...m })) };
}

function run(t, report, category = null) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'unknown-tuples-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, TMPDIR: dir },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, category === null ? 0 : 1);
  assert.equal(result.stdout, category === null ? 'PASS: import report\n' : '');
  assert.equal(result.stderr, category === null ? '' : `FAIL: ${category}\n`);
}

test('accepts exact unknown tuples independent of both array orders', t => {
  for (const edgeOrder of ['original', 'reverse', 'rotate']) {
    for (const unknownOrder of ['original', 'reverse', 'rotate']) {
      const report = fixture();
      const permute = (array, order) => order === 'reverse' ? array.reverse() : order === 'rotate' ? [...array.slice(1), array[0]] : array;
      report.edges = permute(report.edges, edgeOrder);
      report.unknown = permute(report.unknown, unknownOrder);
      run(t, report);
    }
  }
});

test('rejects a single changed tuple component while references remain valid', t => {
  for (const [field, value] of [['from', '__proto__'], ['specifier', 'constructor'], ['kind', 'lazy']]) {
    const report = fixture();
    // This tuple stays distinct from the other unknowns and its importer exists.
    const index = field === 'kind' ? 2 : 0;
    report.unknown[index][field] = value;
    run(t, report, 'inconsistent');
  }
});

test('rejects duplicate unknown tuples', t => {
  const report = fixture();
  report.unknown.push({ ...report.unknown[0] });
  run(t, report, 'duplicate');
});

test('rejects an unknown tuple with an existing target', t => {
  const report = fixture();
  report.unknown[0].to = 'constructor';
  run(t, report, 'inconsistent');
});

test('rejects an unknown tuple with a dangling importer', t => {
  const report = fixture();
  report.unknown[0].from = 'missing secret importer';
  run(t, report, 'reference');
});
