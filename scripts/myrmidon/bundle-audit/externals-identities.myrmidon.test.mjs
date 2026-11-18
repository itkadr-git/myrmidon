import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const run = path => spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10000 });
const fixture = t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'externals-identities-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'report.json');
};
const edge = (from, specifier, kind = 'eager') => ({ from, specifier, kind, to: null });
const hostile = 'quote"\nline';
const seed = () => ({
  entry: 'entry',
  modules: ['entry', '__proto__', 'constructor', 'toString', hostile].map(path => ({ path, bytes: 0, eager: true })),
  edges: [
    edge('__proto__', '__proto__'), edge('__proto__', '__proto__', 'lazy'),
    edge('constructor', 'constructor'), edge('toString', 'toString', 'lazy'),
    edge(hostile, hostile), edge('entry', '@scope/p'), edge('entry', '@scope/p/sub'),
    edge('constructor', '@scope/p'), edge('toString', '@scope/p'), edge(hostile, '@scope/p'),
  ],
});
const expected = {
  entry: 'entry',
  externals: [
    { specifier: '@scope/p', eagerImporters: ['constructor', 'entry', hostile, 'toString'], lazyImporters: [] },
    { specifier: '@scope/p/sub', eagerImporters: ['entry'], lazyImporters: [] },
    { specifier: '__proto__', eagerImporters: ['__proto__'], lazyImporters: ['__proto__'] },
    { specifier: 'constructor', eagerImporters: ['constructor'], lazyImporters: [] },
    { specifier: hostile, eagerImporters: [hostile], lazyImporters: [] },
    { specifier: 'toString', eagerImporters: [], lazyImporters: ['toString'] },
  ],
  unresolvedLocal: [],
};

test('preserves dangerous identities and exact strings regardless of input order', t => {
  const path = fixture(t), report = seed();
  for (const reverse of [false, true]) {
    if (reverse) { report.modules.reverse(); report.edges.reverse(); }
    const input = JSON.stringify(report);
    writeFileSync(path, input);
    for (let i = 0; i < 2; i++) {
      const result = run(path);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, JSON.stringify(expected) + '\n');
      assert.equal(readFileSync(path, 'utf8'), input);
    }
  }
});

test('invalid hostile identities yield category only, without disclosing values', t => {
  const path = fixture(t);
  for (const category of ['shape', 'graph']) {
    const report = seed();
    if (category === 'shape') report.edges[0].kind = hostile;
    else report.edges.push(edge(hostile, hostile));
    const input = JSON.stringify(report);
    writeFileSync(path, input);
    const result = run(path);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, category + '\n');
    assert.equal(readFileSync(path, 'utf8'), input);
  }
});
