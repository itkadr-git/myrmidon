import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-edge-diff.mjs', import.meta.url));
const sentinel = 'SENTINEL_DO_NOT_EXECUTE_OR_LEAK';
const edge = specifier => ({ from: 'entry', specifier, kind: 'lazy', to: null });
const report = (entry, edges) => ({ entry, modules: [{ path: entry, bytes: 1, eager: true }], edges, sentinel });

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'edge-portability-'));
  const files = join(root, 'reports # (\u96ea)');
  const cwd1 = join(root, 'other cwd #1');
  const cwd2 = join(root, 'other cwd (2)');
  for (const dir of [files, cwd1, cwd2]) mkdirSync(dir);
  const put = (name, value) => { const path = join(files, name); writeFileSync(path, value); return path; };
  const base = put('-base.json', JSON.stringify(report('entry', [edge('removed')])));
  const current = put('current # (\u96ea).json', JSON.stringify(report('entry', [edge('added')])));
  const bad = put('bad # (\u96ea).json', `{${sentinel}`);
  const malformed = put('malformed.json', JSON.stringify({ sentinel }));
  const mismatch = put('mismatch.json', JSON.stringify(report('another', [])));
  const sidecar = put('sidecar.txt', sentinel);
  const paths = [base, current, bad, malformed, mismatch, sidecar];
  const before = paths.map(path => readFileSync(path));
  t.after(() => {
    try { paths.forEach((path, i) => assert.deepEqual(readFileSync(path), before[i], path)); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, files, cwd1, cwd2, base, current, bad, malformed, mismatch };
}

function run(cwd, root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, TMPDIR: root }, encoding: 'utf8', timeout: 10000 });
}
function check(result, status, stdout, stderr) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.ok(!result.stderr.includes(sentinel));
  assert.ok(!result.stderr.includes('    at '));
}

test('resolves absolute and relative report paths from two foreign working directories', t => {
  const f = fixture(t);
  const expected = `${JSON.stringify({ entry: 'entry', added: [edge('added')], removed: [edge('removed')] }, null, 2)}\n`;
  for (const cwd of [f.cwd1, f.cwd2]) {
    check(run(cwd, f.root, f.base, f.current), 0, expected, '');
    check(run(cwd, f.root, relative(cwd, f.base), relative(cwd, f.current)), 0, expected, '');
  }
  // The leading ./ makes a hyphen-prefixed filename an explicit relative path.
  check(run(f.files, f.root, './-base.json', './current # (\u96ea).json'), 0, expected, '');
});

test('reports exact errors for both input positions without leaking paths or input', t => {
  const f = fixture(t);
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const invalid of [join(f.files, 'missing # (\u96ea).json'), f.files, f.bad]) {
      for (const args of [[invalid, f.current], [f.base, invalid]]) {
        const result = run(cwd, f.root, ...args);
        check(result, 1, '', 'invalid json or file\n');
        assert.ok(!result.stderr.includes(invalid));
      }
    }
    check(run(cwd, f.root, f.base, f.malformed), 1, '', 'invalid report\n');
    check(run(cwd, f.root, f.base, f.mismatch), 1, '', 'entry mismatch\n');
    check(run(cwd, f.root, f.base, f.current, sentinel), 1, '', 'invalid arguments\n');
  }
});
