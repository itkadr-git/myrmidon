import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const moduleRecord = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, specifier, kind = 'eager', to = null) => ({ from, specifier, kind, to });
const row = (specifier, eagerImporters, lazyImporters) => ({ specifier, eagerImporters, lazyImporters });

// These expected inventories are written independently of the CLI implementation.
const cases = [
  {
    a: { entry: 'a', modules: [moduleRecord('a', 11), moduleRecord('a/child', 5, false)], edges: [edge('a', './child', 'lazy', 'a/child'), edge('a', 'shared'), edge('a/child', 'shared', 'lazy'), edge('a', './missing')] },
    b: { entry: 'b', modules: [moduleRecord('b', 23)], edges: [edge('b', 'shared'), edge('b', 'shared', 'lazy'), edge('b', 'other'), edge('b', './missing', 'lazy')] },
    ea: { entry: 'a', externals: [row('shared', ['a'], ['a/child'])], unresolvedLocal: [row('./missing', ['a'], [])] },
    eb: { entry: 'b', externals: [row('other', ['b'], []), row('shared', ['b'], ['b'])], unresolvedLocal: [row('./missing', [], ['b'])] },
    eu: { entry: 'a', externals: [row('other', ['b'], []), row('shared', ['a', 'b'], ['a/child', 'b'])], unresolvedLocal: [row('./missing', ['a'], ['b'])] },
  },
  {
    a: { entry: 'z', modules: [moduleRecord('z', 7)], edges: [edge('z', '@pkg/sub', 'lazy'), edge('z', '../lost')] },
    b: { entry: 'B', modules: [moduleRecord('B', 41), moduleRecord('B/c', 13)], edges: [edge('B', './c', 'eager', 'B/c'), edge('B/c', '@pkg/sub', 'lazy'), edge('B', '@pkg'), edge('B/c', '../lost')] },
    ea: { entry: 'z', externals: [row('@pkg/sub', [], ['z'])], unresolvedLocal: [row('../lost', ['z'], [])] },
    eb: { entry: 'B', externals: [row('@pkg', ['B'], []), row('@pkg/sub', [], ['B/c'])], unresolvedLocal: [row('../lost', ['B/c'], [])] },
    eu: { entry: 'z', externals: [row('@pkg', ['B'], []), row('@pkg/sub', [], ['B/c', 'z'])], unresolvedLocal: [row('../lost', ['B/c', 'z'], [])] },
  },
  {
    a: { entry: 'left', modules: [moduleRecord('left', 3)], edges: [edge('left', 'node:fs'), edge('left', '/lost', 'lazy')] },
    b: { entry: 'right', modules: [moduleRecord('right', 67)], edges: [edge('right', 'node:fs', 'lazy'), edge('right', 'pkg'), edge('right', '/other')] },
    ea: { entry: 'left', externals: [row('node:fs', ['left'], [])], unresolvedLocal: [row('/lost', [], ['left'])] },
    eb: { entry: 'right', externals: [row('node:fs', [], ['right']), row('pkg', ['right'], [])], unresolvedLocal: [row('/other', ['right'], [])] },
    eu: { entry: 'left', externals: [row('node:fs', ['left'], ['right']), row('pkg', ['right'], [])], unresolvedLocal: [row('/lost', [], ['left']), row('/other', ['right'], [])] },
  },
];

for (const [index, { a, b, ea, eb, eu }] of cases.entries()) {
  test(`disjoint inventory composition ${index + 1}`, () => {
    const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'disjoint-'));
    try {
      const union = { entry: a.entry, modules: [...a.modules, ...b.modules.map(m => ({ ...m, eager: false }))], edges: [...a.edges, ...b.edges] };
      for (const [report, expected] of [[a, ea], [b, eb], [union, eu]]) {
        for (const value of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
          const path = join(dir, 'report.json');
          const before = JSON.stringify(value);
          writeFileSync(path, before);
          for (let repeat = 0; repeat < 2; repeat++) {
            const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10000 });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stderr, '');
            assert.equal(result.stdout, JSON.stringify(expected) + '\n');
            assert.equal(readFileSync(path, 'utf8'), before);
          }
        }
      }
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify({ ...union, edges: [...union.edges, edge(a.entry, './absent', 'eager', 'absent')] }));
      const result = spawnSync(process.execPath, [cli, path], { encoding: 'utf8', timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'graph\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
