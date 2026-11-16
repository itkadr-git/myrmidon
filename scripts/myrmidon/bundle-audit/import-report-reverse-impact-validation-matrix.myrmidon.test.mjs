import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-reverse-impact.mjs', import.meta.url));
const fixture = () => ({
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 0, eager: true },
    { path: 'target', bytes: 1, eager: true },
    { path: 'reachable', bytes: Number.MAX_SAFE_INTEGER, eager: true },
    { path: 'disconnected', bytes: 2, eager: false },
    { path: 'other', bytes: 3, eager: false },
    { path: 'isolated', bytes: 4, eager: false },
  ],
  edges: [
    { from: 'entry', to: 'target', kind: 'eager', specifier: './target' },
    { from: 'entry', to: 'reachable', kind: 'eager', specifier: './reachable' },
    { from: 'disconnected', to: 'other', kind: 'eager', specifier: './other' },
    { from: 'disconnected', to: 'other', kind: 'eager', specifier: './alias' },
  ],
});

const cases = [
  ['report null', r => null, 'shape'],
  ['report array', r => [], 'shape'],
  ['entry empty', r => { r.entry = ''; }, 'shape'],
  ['entry non-string', r => { r.entry = 1; }, 'shape'],
  ['modules non-array', r => { r.modules = {}; }, 'shape'],
  ['modules empty', r => { r.modules = []; }, 'shape'],
  ['edges non-array', r => { r.edges = {}; }, 'shape'],
  ['late module null', r => { r.modules[4] = null; }, 'shape'],
  ['late module array', r => { r.modules[4] = []; }, 'shape'],
  ['late path empty', r => { r.modules[4].path = ''; }, 'shape'],
  ['late path non-string', r => { r.modules[4].path = 4; }, 'shape'],
  ['negative bytes', r => { r.modules[4].bytes = -1; }, 'shape'],
  ['fractional bytes', r => { r.modules[4].bytes = 0.5; }, 'shape'],
  ['unsafe bytes', r => { r.modules[4].bytes = Number.MAX_SAFE_INTEGER + 1; }, 'shape'],
  ['non-number bytes', r => { r.modules[4].bytes = '3'; }, 'shape'],
  ['non-boolean eager', r => { r.modules[4].eager = 0; }, 'shape'],
  ['duplicate late path', r => { r.modules[5].path = 'disconnected'; }, 'graph'],
  ['missing entry', r => { r.entry = 'missing'; }, 'graph'],
  ['late edge null', r => { r.edges[3] = null; }, 'shape'],
  ['late edge array', r => { r.edges[3] = []; }, 'shape'],
  ['empty from', r => { r.edges[3].from = ''; }, 'shape'],
  ['non-string from', r => { r.edges[3].from = 2; }, 'shape'],
  ['non-string specifier', r => { r.edges[3].specifier = null; }, 'shape'],
  ['invalid kind', r => { r.edges[3].kind = 'dynamic'; }, 'shape'],
  ['non-string kind', r => { r.edges[3].kind = false; }, 'shape'],
  ['empty to', r => { r.edges[3].to = ''; }, 'shape'],
  ['non-string to', r => { r.edges[3].to = 2; }, 'shape'],
  ['dangling late from', r => { r.edges[3].from = 'missing'; }, 'graph'],
  ['dangling late to', r => { r.edges[3].to = 'missing'; }, 'graph'],
  ['duplicate late tuple', r => { r.edges[3].specifier = './other'; }, 'graph'],
  ['false reachable eager', r => { r.modules[2].eager = false; }, 'graph'],
  ['true disconnected eager', r => { r.modules[4].eager = true; }, 'graph'],
];

test('whole report validation precedes reverse impact filtering', async t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'reverse-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const run = (report, target = 'target') => {
    writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, [cli, file, target], { encoding: 'utf8', timeout: 5000 });
  };
  const success = (report, target, expected) => {
    const result = run(report, target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  };
  const failure = (report, target, category) => {
    const result = run(report, target);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  };
  success(fixture(), 'target', { entry: 'entry', target: 'target', importers: [{ path: 'entry', distance: 1 }] });
  success(fixture(), 'other', { entry: 'entry', target: 'other', importers: [{ path: 'disconnected', distance: 1 }] });
  failure(fixture(), 'missing', 'graph');
  for (const [label, mutate, category] of cases) {
    await t.test(label, () => {
      const report = fixture();
      const replacement = mutate(report);
      failure(replacement === undefined ? report : replacement, 'target', category);
    });
  }
});
