import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));
const base = { entry: 'entry', modules: [{ path: 'removed', bytes: 8, eager: true }, { path: 'shared', bytes: 4, eager: false }, { path: 'same', bytes: 2, eager: true }], counts: { modules: 3, eagerModules: 2 }, bytes: { total: 14, eager: 10 } };
const current = { entry: 'entry', modules: [{ path: 'added', bytes: 3, eager: false }, { path: 'shared', bytes: 7, eager: true }, { path: 'same', bytes: 2, eager: true }], counts: { modules: 3, eagerModules: 2 }, bytes: { total: 12, eager: 9 } };
const expected = { entry: 'entry', delta: { modules: 0, eagerModules: 0, totalBytes: -2, eagerBytes: -1 }, added: [{ path: 'added', bytes: 3, eager: false }], removed: [{ path: 'removed', bytes: 8, eager: true }], changed: [{ path: 'shared', before: { bytes: 4, eager: false }, after: { bytes: 7, eager: true } }] };
const reverse = { entry: 'entry', delta: { modules: 0, eagerModules: 0, totalBytes: 2, eagerBytes: 1 }, added: [{ path: 'removed', bytes: 8, eager: true }], removed: [{ path: 'added', bytes: 3, eager: false }], changed: [{ path: 'shared', before: { bytes: 7, eager: true }, after: { bytes: 4, eager: false } }] };

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'compare-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'foreign a'), b = join(root, 'foreign b'), tmp = join(root, 'child tmp');
  for (const dir of [a, b, tmp]) mkdirSync(dir);
  const files = [join(a, '-'), join(a, 'base.json'), join(a, 'current.json'), join(a, 'sidecar')];
  for (const [path, data] of files.map((path, i) => [path, [JSON.stringify(base), JSON.stringify(base) + '\n', JSON.stringify(current) + '\n', 'sentinel\n'][i]])) writeFileSync(path, data);
  const snapshots = files.map(path => readFileSync(path));
  const listing = readdirSync(a).sort();
  const run = (cwd, args, input, status, stdout, stderr) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: tmp } });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, status);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, stderr);
    files.forEach((path, i) => assert.deepEqual(readFileSync(path), snapshots[i]));
    assert.deepEqual(readdirSync(a).sort(), listing);
    assert.deepEqual(readdirSync(tmp), []);
  };
  return { a, b, files, run };
}
const json = value => JSON.stringify(value, null, 2) + '\n';

test('one stdin report works in either position and ./- remains a file', t => {
  const f = fixture(t);
  for (const cwd of [f.a, f.b]) {
    const basePath = relative(cwd, f.files[1]);
    const currentPath = relative(cwd, f.files[2]);
    f.run(cwd, [basePath, '-'], JSON.stringify(current), 0, json(expected), '');
    f.run(cwd, ['-', currentPath], JSON.stringify(base), 0, json(expected), '');
    f.run(cwd, [currentPath, '-'], JSON.stringify(base), 0, json(reverse), '');
    f.run(cwd, [cwd === f.a ? './-' : relative(cwd, f.files[0]), currentPath], 'not a report', 0, json(expected), '');
    f.run(cwd, [basePath, currentPath], '', 0, json(expected), '');
  }
});

test('stdin errors retain exact dispatch and report validation semantics', t => {
  const f = fixture(t);
  for (const cwd of [f.a, f.b]) {
    for (const input of ['', ' \n\t', '{', '{} {}']) {
      f.run(cwd, ['-', f.files[2]], input, 1, '', 'invalid json or file\n');
      f.run(cwd, [f.files[1], '-'], input, 1, '', 'invalid json or file\n');
    }
    for (const args of [['-', '-'], ['-'], ['-', f.files[2], 'extra'], []]) f.run(cwd, args, '{', 1, '', 'invalid arguments\n');
    for (const [report, error] of [[{}, 'invalid report'], [{ ...base, modules: [{ path: 'x', bytes: -1, eager: true }] }, 'invalid module'], [{ ...base, counts: { ...base.counts, modules: 0 } }, 'invalid totals'], [{ ...base, entry: 'other' }, 'entry mismatch']]) {
      f.run(cwd, ['-', f.files[2]], JSON.stringify(report), 1, '', error + '\n');
      f.run(cwd, [f.files[2], '-'], JSON.stringify(report), 1, '', error + '\n');
    }
  }
});
