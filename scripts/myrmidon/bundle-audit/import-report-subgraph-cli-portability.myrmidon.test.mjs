import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-subgraph.mjs');
const sentinel = 'portability-sentinel-93248';
const report = {
  entry: 'root',
  modules: [{path: 'root', bytes: 1, eager: true}, {path: 'lazy', bytes: 2, eager: false}],
  edges: [{from: 'root', specifier: './lazy', kind: 'lazy', to: 'lazy'}, {from: 'root', specifier: sentinel, kind: 'eager', to: null}],
};
const expected = {
  eager: {root: 'root', mode: 'eager', modules: [report.modules[0]], edges: [report.edges[1]], unknown: [report.edges[1]]},
  all: {root: 'root', mode: 'all', modules: [report.modules[1], report.modules[0]], edges: report.edges, unknown: [report.edges[1]]},
};
function fixture(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-portability-'));
  t.after(() => rmSync(tmp, {recursive: true, force: true}));
  const cwd1 = join(tmp, 'cwd-one'); const cwd2 = join(tmp, 'cwd-two');
  const dir = join(tmp, `${sentinel} # (отчёт)`);
  for (const path of [cwd1, cwd2, dir]) mkdirSync(path);
  const file = join(dir, 'report.json'); const sidecar = join(dir, 'sentinel.txt');
  writeFileSync(file, JSON.stringify(report)); writeFileSync(sidecar, sentinel);
  return {tmp, cwd1, cwd2, dir, file, sidecar};
}
function run(f, cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {cwd, encoding: 'utf8', timeout: 10000, env: {...process.env, TMPDIR: f.tmp}});
}
function success(result, mode) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(result.stderr, ''); assert.equal(result.stdout, JSON.stringify(expected[mode]) + '\n');
}
function failure(result, category, f, input) {
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, `${category} error\n`);
  for (const secret of [sentinel, f.tmp, input, '    at ']) assert.ok(!result.stderr.includes(secret));
}

test('foreign cwd paths, modes, dash basename and repeated runs preserve files', t => {
  const f = fixture(t);
  const before = readFileSync(f.file); const sidecar = readFileSync(f.sidecar); const listing = readdirSync(f.dir).sort();
  for (const cwd of [f.cwd1, f.cwd2]) for (const mode of ['eager', 'all']) {
    for (const path of [f.file, relative(cwd, f.file)]) {
      success(run(f, cwd, path, 'root', mode), mode);
      success(run(f, cwd, path, 'root', mode), mode);
    }
  }
  const dash = join(f.cwd1, '-report.json'); writeFileSync(dash, before);
  for (const mode of ['eager', 'all']) success(run(f, f.cwd1, './-report.json', 'root', mode), mode);
  assert.deepEqual(readFileSync(dash), before);
  assert.deepEqual(readFileSync(f.file), before); assert.deepEqual(readFileSync(f.sidecar), sidecar);
  assert.deepEqual(readdirSync(f.dir).sort(), listing);
});

test('foreign cwd failures are atomic and do not leak input', t => {
  const f = fixture(t); const input = JSON.stringify(report);
  const bad = join(f.dir, 'bad.json'); const shape = join(f.dir, 'shape.json'); const graph = join(f.dir, 'graph.json');
  writeFileSync(bad, `{\"${sentinel}\":`); writeFileSync(shape, JSON.stringify({sentinel}));
  writeFileSync(graph, JSON.stringify({...report, entry: sentinel}));
  const cases = [
    [[], 'argv'], [[f.file, 'root'], 'argv'], [[f.file, 'root', 'all', sentinel], 'argv'],
    [[join(f.dir, 'missing.json'), 'root', 'all'], 'read'], [[f.dir, 'root', 'all'], 'read'],
    [[bad, 'root', 'all'], 'json'], [[shape, 'root', 'all'], 'shape'], [[graph, 'root', 'all'], 'graph'],
  ];
  for (const cwd of [f.cwd1, f.cwd2]) for (const [args, category] of cases) {
    failure(run(f, cwd, ...args), category, f, input);
  }
});
