import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const base = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 0, eager: true },
    { path: 'root', bytes: Number.MAX_SAFE_INTEGER, eager: false, note: 'module metadata' },
    { path: 'outside', bytes: 4, eager: false },
    { path: 'other', bytes: 5, eager: false },
  ],
  edges: [
    { from: 'root', specifier: 'external', kind: 'eager', to: null, note: 'edge metadata' },
    { from: 'outside', specifier: 'other', kind: 'lazy', to: 'other' },
    { from: 'outside', specifier: 'duplicate', kind: 'lazy', to: 'other' },
  ],
};

function setup(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'subgraph-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
}
function run(file, root = 'root', mode = 'all') {
  return spawnSync(process.execPath, [cli, file, root, mode], { encoding: 'utf8', timeout: 10000 });
}
function rejected(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category} error\n`);
}

test('validation of discarded modules and edges is fail-closed in both modes', async t => {
  const cases = [
    ['duplicate module path', r => { r.modules[3].path = 'outside'; }, 'graph'],
    ['duplicate edge tuple', r => { r.edges[2].specifier = 'other'; }, 'graph'],
    ['dangling from', r => { r.edges[1].from = 'missing'; }, 'graph'],
    ['dangling to', r => { r.edges[1].to = 'missing'; }, 'graph'],
    ['bad kind', r => { r.edges[1].kind = 'invalid'; }, 'shape'],
    ['module is null', r => { r.modules[2] = null; }, 'shape'],
    ['empty module path', r => { r.modules[2].path = ''; }, 'shape'],
    ['nonboolean eager', r => { r.modules[2].eager = 'false'; }, 'shape'],
    ...[null, '4', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(value => [
      `invalid bytes ${String(value)}`, r => { r.modules[2].bytes = value; }, 'shape',
    ]),
    ['missing root', () => {}, 'graph', 'missing'],
  ];
  const file = setup(t);
  for (const [name, mutate, category, root = 'root'] of cases) {
    await t.test(name, () => {
      const value = structuredClone(base);
      mutate(value);
      writeFileSync(file, JSON.stringify(value));
      for (const mode of ['eager', 'all']) rejected(run(file, root, mode), category);
    });
  }
});

test('valid projection preserves eager flags and metadata at safe byte boundaries', t => {
  const file = setup(t);
  writeFileSync(file, JSON.stringify(base));
  for (const mode of ['eager', 'all']) {
    const result = run(file, 'root', mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      root: 'root', mode,
      modules: [{ path: 'root', bytes: Number.MAX_SAFE_INTEGER, eager: false, note: 'module metadata' }],
      edges: [{ from: 'root', specifier: 'external', kind: 'eager', to: null, note: 'edge metadata' }],
      unknown: [{ from: 'root', specifier: 'external', kind: 'eager', to: null, note: 'edge metadata' }],
    });
  }
});

test('invalid argv has its own exact error category', t => {
  const file = setup(t);
  writeFileSync(file, JSON.stringify(base));
  for (const args of [[], [file, 'root', 'invalid'], [file, '', 'all'], [file, 'root', 'all', 'extra']]) {
    rejected(spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 }), 'argv');
  }
});
