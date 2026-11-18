import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./import-report-externals.mjs', import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const sentinel = 'portability-sentinel-4e9d21';

function setup(t) {
  const root = mkdtempSync(join(scratch, `${sentinel}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd1 = join(root, 'cwd one');
  const cwd2 = join(root, 'cwd two');
  const reports = join(root, 'reports # (данные)');
  for (const dir of [cwd1, cwd2, reports]) mkdirSync(dir);
  const report = {
    entry: 'entry.mjs',
    modules: [{ path: 'entry.mjs', bytes: 0, eager: true }],
    edges: [{ from: 'entry.mjs', specifier: './missing.mjs', kind: 'lazy', to: null }],
    sentinel,
  };
  const input = join(reports, 'report # (данные).json');
  const dash = join(cwd1, '-report.json');
  const sidecar = join(reports, 'sidecar.txt');
  const bytes = JSON.stringify(report);
  writeFileSync(input, bytes);
  writeFileSync(dash, bytes);
  writeFileSync(sidecar, sentinel);
  return { root, cwd1, cwd2, reports, input, dash, sidecar, bytes };
}

function run(root, cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: root },
  });
}

function success(result, expected) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

test('foreign cwd paths and repeated runs preserve input and directory', t => {
  const f = setup(t);
  const expected = JSON.stringify({ entry: 'entry.mjs', externals: [], unresolvedLocal: [
    { specifier: './missing.mjs', eagerImporters: [], lazyImporters: ['entry.mjs'] },
  ] }) + '\n';
  const directoryBefore = readdirSync(f.reports).sort();
  const cwdBefore = readdirSync(f.cwd1).sort();
  for (const cwd of [f.cwd1, f.cwd2]) {
    for (const input of [f.input, relative(cwd, f.input)]) {
      success(run(f.root, cwd, [input]), expected);
      success(run(f.root, cwd, [input]), expected);
    }
  }
  success(run(f.root, f.cwd1, ['./-report.json']), expected);
  success(run(f.root, f.cwd1, ['./-report.json']), expected);
  assert.equal(readFileSync(f.input, 'utf8'), f.bytes);
  assert.equal(readFileSync(f.dash, 'utf8'), f.bytes);
  assert.equal(readFileSync(f.sidecar, 'utf8'), sentinel);
  assert.deepEqual(readdirSync(f.reports).sort(), directoryBefore);
  assert.deepEqual(readdirSync(f.cwd1).sort(), cwdBefore);
});

test('foreign cwd errors are atomic and expose only the exact category', t => {
  const f = setup(t);
  const badJson = join(f.reports, 'bad.json');
  const badShape = join(f.reports, 'shape.json');
  const badGraph = join(f.reports, 'graph.json');
  const malformed = `{"${sentinel}":`;
  const shape = JSON.stringify({ sentinel });
  const graph = JSON.stringify({ entry: sentinel, modules: [], edges: [] });
  writeFileSync(badJson, malformed);
  writeFileSync(badShape, shape);
  writeFileSync(badGraph, graph);
  const cases = [
    [[], 'argv'],
    [[f.input, 'extra'], 'argv'],
    [[relative(f.cwd2, join(f.reports, 'missing.json'))], 'read'],
    [[relative(f.cwd2, f.reports)], 'read'],
    [[relative(f.cwd2, badJson)], 'json'],
    [[relative(f.cwd2, badShape)], 'shape'],
    [[relative(f.cwd2, badGraph)], 'graph'],
  ];
  for (const [args, category] of cases) {
    const result = run(f.root, f.cwd2, args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
    for (const privateValue of [sentinel, f.root, malformed, shape, graph, 'Error:', '    at ']) {
      assert.equal(result.stderr.includes(privateValue), false);
    }
  }
});
