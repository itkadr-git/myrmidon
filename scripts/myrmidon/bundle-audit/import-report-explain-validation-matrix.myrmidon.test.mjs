import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-explain.mjs');
const sentinel = 'UNKNOWN_TARGET_SENTINEL';
const fixture = () => ({
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'target', bytes: 2, eager: true },
    { path: 'isolated', bytes: 0, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: './target', kind: 'eager', to: 'target' },
    { from: 'isolated', specifier: 'external', kind: 'lazy', to: null },
  ],
});

const cases = [
  ['null root', () => null],
  ['array root', () => []],
  ['entry type', r => { r.entry = 1; }],
  ['entry absent from modules', r => { r.entry = 'missing'; }],
  ['modules type', r => { r.modules = {}; }],
  ['edges type', r => { r.edges = {}; }],
  ['module object', r => { r.modules[1] = null; }],
  ['module path type', r => { r.modules[1].path = 1; }],
  ['module path empty', r => { r.modules[1].path = ''; }],
  ['module bytes type', r => { r.modules[1].bytes = '2'; }],
  ['module bytes negative', r => { r.modules[1].bytes = -1; }],
  ['module bytes fraction', r => { r.modules[1].bytes = 0.5; }],
  ['module bytes unsafe', r => { r.modules[1].bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['module eager type', r => { r.modules[1].eager = 1; }],
  ['duplicate module', r => { r.modules[1].path = 'entry'; }],
  ['edge object', r => { r.edges[0] = null; }],
  ['edge from type', r => { r.edges[0].from = 1; }],
  ['edge from empty', r => { r.edges[0].from = ''; }],
  ['edge from missing', r => { r.edges[0].from = 'missing'; }],
  ['edge specifier type', r => { r.edges[0].specifier = 1; }],
  ['edge specifier empty', r => { r.edges[0].specifier = ''; }],
  ['edge kind', r => { r.edges[0].kind = 'other'; }],
  ['edge to type', r => { r.edges[0].to = 1; }],
  ['edge to missing', r => { r.edges[0].to = 'missing'; }],
  ['duplicate edge', r => { r.edges[1] = { ...r.edges[0] }; }],
  ['late disconnected invalid edge', r => { r.edges[1].kind = 'invalid'; }],
];

test('validation matrix rejects malformed reports before target lookup', async t => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'explain-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'report.json');
  function run(report, target) {
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    return result;
  }
  function error(result, expected) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `error: ${expected}\n`);
    assert.equal(result.stderr.includes(sentinel), false);
  }
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const report = fixture();
      const changed = mutate(report);
      const value = changed === undefined ? report : changed;
      error(run(value, 'target'), 'report');
      error(run(value, sentinel), 'report');
    });
  }
  await t.test('valid report distinguishes a missing target', () => error(run(fixture(), sentinel), 'target'));
  for (const [target, reachable, path] of [['target', true, ['entry', 'target']], ['isolated', false, []]]) {
    await t.test(`valid ${target}`, () => {
      const result = run(fixture(), target);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { entry: 'entry', target, reachable, path });
      assert.equal(result.stdout, JSON.stringify({ entry: 'entry', target, reachable, path }) + '\n');
    });
  }
});
