import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const moduleFor = path => ({ path, bytes: 1, eager: true });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${to}` });

function harness(t) {
  const dir = mkdtempSync(join(root, 'cycles-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  return report => {
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file], {
      encoding: 'utf8', shell: false, timeout: 10000, env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
}

function base(reverse, kind) {
  const modules = ['a', 'b', 'c', 'd', 'x', 'y'].map(moduleFor);
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
  if (reverse) { modules.reverse(); edges.reverse(); }
  return { entry: 'a', modules, edges, kind };
}

const moduleCases = [
  ['null module', () => null], ['array module', () => []],
  ['missing bytes', () => ({ path: 'z', eager: false })],
  ...[null, '1', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(value =>
    [`bytes ${String(value)}`, () => ({ ...moduleFor('z'), bytes: value })]),
  ['non-boolean eager', () => ({ ...moduleFor('z'), eager: 'false' })],
  ['empty path', () => ({ ...moduleFor('z'), path: '' })],
];
const edgeCases = [
  ['null edge', () => null, 'shape'], ['array edge', () => [], 'shape'],
  ['empty specifier', kind => ({ ...edge('x', 'y', kind), specifier: '' }), 'shape'],
  ['unknown kind', () => ({ ...edge('x', 'y'), kind: 'unknown' }), 'shape'],
  ['missing to', kind => ({ from: 'x', specifier: './y', kind }), 'shape'],
  ['dangling from', kind => edge('missing', 'y', kind), 'reference'],
  ['dangling to', kind => edge('x', 'missing', kind), 'reference'],
];

test('rejects late disconnected module and edge defects for every prefix order and edge kind', t => {
  const run = harness(t);
  for (const reverse of [false, true]) for (const kind of ['eager', 'lazy']) {
    const check = (report, category, label) => {
      const result = run(report);
      const context = `${label}; reverse=${reverse}; kind=${kind}`;
      assert.equal(result.status, 1, context);
      assert.equal(result.stdout, '', context);
      assert.equal(result.stderr, `FAIL: ${category}\n`, context);
    };
    for (const [name, make] of moduleCases) {
      const report = base(reverse, kind); report.modules.push(make());
      check(report, 'shape', name);
    }
    const duplicateModule = base(reverse, kind); duplicateModule.modules.push({ ...duplicateModule.modules[0] });
    check(duplicateModule, 'duplicate', 'duplicate module');
    for (const [name, make, category] of edgeCases) {
      const report = base(reverse, kind); report.edges.push(make(kind));
      check(report, category, name);
    }
    const duplicateEdge = base(reverse, kind);
    duplicateEdge.edges.push(edge('x', 'y', kind), edge('x', 'y', kind));
    check(duplicateEdge, 'duplicate', 'duplicate edge');
  }
});

test('accepts disconnected valid edges and null targets', t => {
  const run = harness(t);
  for (const reverse of [false, true]) for (const kind of ['eager', 'lazy']) {
    const report = base(reverse, kind);
    report.edges.push(edge('x', 'y', kind), edge('y', null, kind));
    const result = run(report);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '{"entry":"a","eagerCycles":[],"allCycles":[]}\n');
  }
});
