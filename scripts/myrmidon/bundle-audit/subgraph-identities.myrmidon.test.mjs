import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const strange = 'dir\\"line\nfile';
const seed = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 7, eager: true },
    { path: '__proto__', bytes: 0, eager: false },
    { path: 'constructor', bytes: 2, eager: false },
    { path: strange, bytes: 3, eager: false },
  ],
  edges: [
    { from: '__proto__', specifier: 'alias-b', kind: 'eager', to: 'constructor' },
    { from: 'constructor', specifier: 'cycle', kind: 'eager', to: '__proto__' },
    { from: '__proto__', specifier: 'alias-a', kind: 'eager', to: 'constructor' },
    { from: '__proto__', specifier: 'alias-a', kind: 'lazy', to: 'constructor' },
    { from: '__proto__', specifier: 'missing-eager', kind: 'eager', to: null },
    { from: '__proto__', specifier: 'missing-lazy', kind: 'lazy', to: null },
    { from: 'constructor', specifier: 'strange', kind: 'lazy', to: strange },
    { from: strange, specifier: 'back', kind: 'eager', to: '__proto__' },
  ],
};

// These are hand-written projections, not derived from the input or the CLI.
const eager = {
  root: '__proto__', mode: 'eager',
  modules: [{ path: '__proto__', bytes: 0, eager: false }, { path: 'constructor', bytes: 2, eager: false }],
  edges: [
    { from: '__proto__', specifier: 'alias-a', kind: 'eager', to: 'constructor' },
    { from: '__proto__', specifier: 'alias-b', kind: 'eager', to: 'constructor' },
    { from: '__proto__', specifier: 'missing-eager', kind: 'eager', to: null },
    { from: 'constructor', specifier: 'cycle', kind: 'eager', to: '__proto__' },
  ],
  unknown: [{ from: '__proto__', specifier: 'missing-eager', kind: 'eager', to: null }],
};
const all = {
  root: '__proto__', mode: 'all',
  modules: [{ path: '__proto__', bytes: 0, eager: false }, { path: 'constructor', bytes: 2, eager: false }, { path: strange, bytes: 3, eager: false }],
  edges: [
    { from: '__proto__', specifier: 'alias-a', kind: 'eager', to: 'constructor' },
    { from: '__proto__', specifier: 'alias-a', kind: 'lazy', to: 'constructor' },
    { from: '__proto__', specifier: 'alias-b', kind: 'eager', to: 'constructor' },
    { from: '__proto__', specifier: 'missing-eager', kind: 'eager', to: null },
    { from: '__proto__', specifier: 'missing-lazy', kind: 'lazy', to: null },
    { from: 'constructor', specifier: 'cycle', kind: 'eager', to: '__proto__' },
    { from: 'constructor', specifier: 'strange', kind: 'lazy', to: strange },
    { from: strange, specifier: 'back', kind: 'eager', to: '__proto__' },
  ],
  unknown: [
    { from: '__proto__', specifier: 'missing-eager', kind: 'eager', to: null },
    { from: '__proto__', specifier: 'missing-lazy', kind: 'lazy', to: null },
  ],
};

function fixture(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(base, 'subgraph-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
}
function run(file, root, mode) {
  return spawnSync(process.execPath, [cli, file, root, mode], { encoding: 'utf8', timeout: 10000 });
}
function expectProjection(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

test('reroot preserves identities, aliases, flags and unknown edges in both modes', t => {
  const file = fixture(t);
  for (const report of [seed, { ...seed, modules: [...seed.modules].reverse(), edges: [...seed.edges].reverse() }]) {
    writeFileSync(file, JSON.stringify(report));
    for (const [mode, expected] of [['eager', eager], ['all', all]]) {
      expectProjection(run(file, '__proto__', mode), expected);
      expectProjection(run(file, '__proto__', mode), expected);
    }
  }
});

test('a similar but absent root returns only a graph error', t => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify(seed));
  for (const root of ['__proto_', 'constructo', strange + 'x']) {
    const result = run(file, root, 'all');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph error\n');
  }
});
