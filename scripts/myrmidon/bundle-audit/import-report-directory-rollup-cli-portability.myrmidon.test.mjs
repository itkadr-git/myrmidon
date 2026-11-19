import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const sentinel = 'PORTABILITY_SENTINEL_746219';
const report = {
  entry: 'entry.js',
  modules: [{ path: 'entry.js', bytes: 3, eager: true }, { path: 'lazy/mod.js', bytes: 5, eager: false }],
  edges: [{ from: 'entry.js', specifier: sentinel, kind: 'lazy', to: 'lazy/mod.js' },
    { from: 'entry.js', specifier: 'unresolved', kind: 'lazy', to: null }],
};
const expected = JSON.stringify({ entry: 'entry.js', directories: [
  { directory: '.', modules: 1, eagerModules: 1, totalBytes: 3, eagerBytes: 3 },
  { directory: 'lazy', modules: 1, eagerModules: 0, totalBytes: 5, eagerBytes: 0 },
] }) + '\n';

function setup(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'rollup-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'cwd one'), cwd2 = join(root, 'cwd two');
  const inputDir = join(cwd1, `space # (\u0436) ${sentinel}`);
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(cwd2);
  return { root, cwd1, cwd2, inputDir };
}
function run(cwd, root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: root },
  });
}
function checkSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}
function checkFailure(result, category, paths, input) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
  for (const secret of [sentinel, ...paths, input]) assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes('    at '));
}

test('paths are portable across working directories without changing inputs or sidecars', t => {
  const { root, cwd1, cwd2, inputDir } = setup(t);
  const file = join(inputDir, 'report.json'), sidecar = join(inputDir, 'sidecar.txt');
  const dash = join(cwd2, '-report.json');
  const bytes = Buffer.from(JSON.stringify(report));
  const sidecarBytes = Buffer.from(`sidecar ${sentinel}`);
  writeFileSync(file, bytes); writeFileSync(dash, bytes); writeFileSync(sidecar, sidecarBytes);
  const before = readdirSync(inputDir).sort();
  for (const cwd of [cwd1, cwd2]) {
    for (const path of [file, relative(cwd, file)]) {
      checkSuccess(run(cwd, root, path));
      checkSuccess(run(cwd, root, path));
    }
  }
  checkSuccess(run(cwd2, root, './-report.json'));
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readFileSync(dash), bytes);
  assert.deepEqual(readFileSync(sidecar), sidecarBytes);
  assert.deepEqual(readdirSync(inputDir).sort(), before);
});

test('foreign cwd failures have exact atomic error protocol and do not leak input', t => {
  const { root, cwd1, cwd2, inputDir } = setup(t);
  const file = join(inputDir, 'report.json'), malformed = join(inputDir, 'bad.json');
  const shape = join(inputDir, 'shape.json'), graph = join(inputDir, 'graph.json');
  const input = JSON.stringify(report), badInput = `${sentinel}{`;
  const shapeInput = JSON.stringify({ sentinel }), graphInput = JSON.stringify({ ...report, entry: sentinel });
  writeFileSync(file, input); writeFileSync(malformed, badInput);
  writeFileSync(shape, shapeInput); writeFileSync(graph, graphInput);
  for (const cwd of [cwd1, cwd2]) {
    const cases = [
      [[], 'argv', input], [[file, 'extra'], 'argv', input],
      [[join(inputDir, 'missing.json')], 'file', input], [[inputDir], 'file', input],
      [[malformed], 'json', badInput], [[shape], 'shape', shapeInput], [[graph], 'graph', graphInput],
    ];
    for (const [args, category, contents] of cases) {
      checkFailure(run(cwd, root, ...args), category, [root, file, inputDir], contents);
    }
  }
});
