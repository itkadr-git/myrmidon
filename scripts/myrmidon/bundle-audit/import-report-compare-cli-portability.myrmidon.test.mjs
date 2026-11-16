import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-compare.mjs', import.meta.url));
const baseReport = { entry: 'entry.mjs', modules: [{ path: 'old', bytes: 2, eager: false }, { path: 'shared', bytes: 3, eager: true }], counts: { modules: 2, eagerModules: 1 }, bytes: { total: 5, eager: 3 } };
const currentReport = { entry: 'entry.mjs', modules: [{ path: 'new', bytes: 4, eager: true }, { path: 'shared', bytes: 5, eager: true }], counts: { modules: 2, eagerModules: 2 }, bytes: { total: 9, eager: 9 } };
const expected = { entry: 'entry.mjs', delta: { modules: 0, eagerModules: 1, totalBytes: 4, eagerBytes: 6 }, added: [{ path: 'new', bytes: 4, eager: true }], removed: [{ path: 'old', bytes: 2, eager: false }], changed: [{ path: 'shared', before: { bytes: 3, eager: true }, after: { bytes: 5, eager: true } }] };

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'compare portability # \u6d4b\u8bd5-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'first cwd # \u6d4b\u8bd5');
  const cwd2 = join(root, 'second cwd # \u6d4b\u8bd5');
  const tmp = join(root, 'child tmp');
  for (const dir of [cwd1, cwd2, tmp]) mkdirSync(dir);
  const put = (name, value) => { const path = join(cwd1, name); writeFileSync(path, value); return path; };
  const base = put('-base.json', JSON.stringify(baseReport, null, 1) + '\n');
  const current = put('current # \u6d4b\u8bd5.json', JSON.stringify(currentReport) + '\n');
  const bad = put('bad SENTINEL.json', '{ SENTINEL');
  const invalid = put('invalid totals.json', JSON.stringify({ ...currentReport, bytes: { ...currentReport.bytes, total: 999 } }));
  const mismatch = put('mismatch.json', JSON.stringify({ ...currentReport, entry: 'SENTINEL' }));
  const sidecar = put('sidecar.txt', 'SENTINEL sidecar\n');
  const snapshots = new Map([base, current, bad, invalid, mismatch, sidecar].map(path => [path, readFileSync(path)]));
  const listing = readdirSync(cwd1).sort();
  const run = (cwd, args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const unchanged = () => {
    for (const [path, bytes] of snapshots) assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readdirSync(cwd1).sort(), listing);
    assert.deepEqual(readdirSync(tmp), []);
  };
  return { root, cwd1, cwd2, base, current, bad, invalid, mismatch, run, unchanged };
}

test('CLI preserves input bytes and sidecars across absolute and relative paths from foreign working directories', t => {
  const f = fixture(t);
  for (const [cwd, base, current] of [[f.cwd1, './-base.json', relative(f.cwd1, f.current)], [f.cwd2, f.base, f.current], [f.cwd2, relative(f.cwd2, f.base), relative(f.cwd2, f.current)]]) {
    const result = f.run(cwd, [base, current]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected, null, 2) + '\n');
    f.unchanged();
  }
});

test('CLI returns exact sanitized errors for both report positions and argument dispatch', t => {
  const f = fixture(t);
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const path of [join(f.root, 'missing SENTINEL.json'), f.cwd1, f.bad]) {
      for (const args of [[path, f.current], [f.base, path]]) {
        const result = f.run(cwd, args);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'invalid json or file\n');
      }
    }
    for (const [args, error] of [[[f.base, f.invalid], 'invalid totals'], [[f.base, f.mismatch], 'entry mismatch'], [[f.base, f.current, 'SENTINEL'], 'invalid arguments']]) {
      const result = f.run(cwd, args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, error + '\n');
    }
    f.unchanged();
  }
});
