import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const fixture = {
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 17, eager: true },
    { path: 'a', bytes: 23, eager: true },
    { path: 'b', bytes: 31, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: './a', kind: 'eager', to: 'a' },
    { from: 'a', specifier: './b', kind: 'lazy', to: 'b' },
    { from: 'a', specifier: 'pkg/sub', kind: 'eager', to: null },
    { from: 'a', specifier: 'pkg/sub', kind: 'lazy', to: null },
    { from: 'b', specifier: 'pkg/sub', kind: 'eager', to: null },
    { from: 'entry', specifier: '@scope/pkg', kind: 'lazy', to: null },
    { from: 'b', specifier: '@scope/pkg', kind: 'eager', to: null },
    { from: 'a', specifier: './missing', kind: 'eager', to: null },
    { from: 'b', specifier: './missing', kind: 'lazy', to: null },
  ],
};
const expected = {
  entry: 'entry',
  externals: [
    { specifier: '@scope/pkg', eagerImporters: ['b'], lazyImporters: ['entry'] },
    { specifier: 'pkg/sub', eagerImporters: ['a', 'b'], lazyImporters: ['a'] },
  ],
  unresolvedLocal: [
    { specifier: './missing', eagerImporters: ['a'], lazyImporters: ['b'] },
  ],
};
const maps = [
  { entry: 'x', a: 'z', b: 'y' },
  { entry: 'nested/z/main', a: 'nested/z/child', b: 'nested/a/child' },
  { entry: '\u96ea/main', a: '\u03c9', b: '\u03b1' },
];
const rename = (report, map) => ({
  ...report,
  entry: map[report.entry],
  modules: report.modules.map(module => ({ ...module, path: map[module.path] })),
  edges: report.edges.map(edge => ({ ...edge, from: map[edge.from], to: edge.to === null ? null : map[edge.to] })),
});
const normalize = (report, inverse) => ({
  ...report,
  entry: inverse[report.entry],
  externals: report.externals.map(row => ({ ...row,
    eagerImporters: row.eagerImporters.map(id => inverse[id]).sort(),
    lazyImporters: row.lazyImporters.map(id => inverse[id]).sort(),
  })),
  unresolvedLocal: report.unresolvedLocal.map(row => ({ ...row,
    eagerImporters: row.eagerImporters.map(id => inverse[id]).sort(),
    lazyImporters: row.lazyImporters.map(id => inverse[id]).sort(),
  })),
});

test('external inventory survives identity bijections without changing specifiers', t => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'identity-bijection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  const original = JSON.stringify(fixture);
  const run = report => {
    const source = JSON.stringify(report);
    writeFileSync(path, source);
    const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(readFileSync(path, 'utf8'), source);
    return result;
  };
  const positive = report => {
    const first = run(report), second = run(report);
    for (const result of [first, second]) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
    }
    assert.equal(first.stdout, second.stdout);
    return JSON.parse(first.stdout);
  };
  assert.deepEqual(positive(fixture), expected);
  for (const map of maps) {
    assert.equal(new Set(Object.values(map)).size, fixture.modules.length);
    const inverse = Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
    const actual = positive(rename(fixture, map));
    // The CLI orders importer identities lexically before they are mapped back.
    for (const row of [...actual.externals, ...actual.unresolvedLocal]) {
      assert.deepEqual(row.eagerImporters, [...row.eagerImporters].sort());
      assert.deepEqual(row.lazyImporters, [...row.lazyImporters].sort());
    }
    assert.deepEqual(normalize(actual, inverse), expected);
  }
  const collision = run(rename(fixture, { entry: 'x', a: 'same', b: 'same' }));
  assert.notEqual(collision.status, 0);
  assert.equal(collision.stdout, '');
  assert.equal(JSON.stringify(fixture), original);
});
