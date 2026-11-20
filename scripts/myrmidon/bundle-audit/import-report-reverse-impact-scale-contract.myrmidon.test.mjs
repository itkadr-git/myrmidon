import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-reverse-impact.mjs', import.meta.url).pathname;
const node = i => `node-${String(i).padStart(5, '0')}`;
const moduleFor = path => ({ path, bytes: 1, eager: true });
const edge = (from, to, specifier = to) => ({ from, to, kind: 'eager', specifier });

function check(t, report, target, importers) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const dir = mkdtempSync(join(root, 'reverse-impact-scale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const expected = { entry: report.entry, target, importers };
  for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    writeFileSync(file, JSON.stringify(input));
    const result = spawnSync(process.execPath, [cli, file, target], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, TMPDIR: dir },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^[^\n]+\n$/);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
}

test('deep eager chain includes every importer and the entry', t => {
  const count = 16000;
  const paths = Array.from({ length: count }, (_, i) => node(i));
  const report = {
    entry: paths[0], modules: paths.map(moduleFor),
    edges: paths.slice(0, -1).map((path, i) => edge(path, paths[i + 1])),
  };
  const importers = Array.from({ length: count - 1 }, (_, i) => ({ path: paths[count - 2 - i], distance: i + 1 }));
  check(t, report, paths[count - 1], importers);
});

test('direct importer aliases are deduplicated and ordered by code unit', t => {
  const paths = Array.from({ length: 10000 }, (_, i) => node(i));
  const target = 'target';
  const report = {
    entry: paths[0], modules: [...paths, target].map(moduleFor),
    edges: [
      ...paths.slice(1).map(path => edge(paths[0], path)),
      ...paths.flatMap(path => [edge(path, target, 'alias-a'), edge(path, target, 'alias-b')]),
    ],
  };
  check(t, report, target, paths.map(path => ({ path, distance: 1 })));
});

test('large eager cycle excludes the target and preserves shortest distances', t => {
  const count = 12000;
  const paths = Array.from({ length: count }, (_, i) => node(i));
  const report = {
    entry: paths[0], modules: paths.map(moduleFor),
    edges: paths.map((path, i) => edge(path, paths[(i + 1) % count])),
  };
  const target = paths[0];
  const importers = Array.from({ length: count - 1 }, (_, i) => ({ path: paths[count - 1 - i], distance: i + 1 }));
  check(t, report, target, importers);
});
