import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const scanner = join(dir, 'import-budget.mjs');
const subgraph = join(dir, 'import-report-subgraph.mjs');
const sources = {
  'entry.mjs': "import './sub/a.mjs';\n",
  'sub/a.mjs': "import './dep.mjs';\nimport './missing.mjs';\nimport('./lazy.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.SENTINEL, 'executed');\n",
  'sub/dep.mjs': 'export const dep = 1;\n',
  'sub/lazy.mjs': "import './leaf.mjs';\n",
  'sub/leaf.mjs': 'export const leaf = 1;\n',
};
const changed = "import './dep.mjs';\nimport './missing.mjs';\nimport('./leaf.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.SENTINEL, 'executed');\n";
const moduleRecord = (path, contents, eager) => ({ path, bytes: Buffer.byteLength(contents), eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const depEdge = edge('sub/a.mjs', './dep.mjs', 'eager', 'sub/dep.mjs');
const missingEdge = edge('sub/a.mjs', './missing.mjs', 'eager', null);
const lazyEdge = edge('sub/a.mjs', './lazy.mjs', 'lazy', 'sub/lazy.mjs');
const leafEdge = edge('sub/lazy.mjs', './leaf.mjs', 'eager', 'sub/leaf.mjs');
const changedEdge = edge('sub/a.mjs', './leaf.mjs', 'lazy', 'sub/leaf.mjs');

function expected(mode, control = false) {
  const modules = [moduleRecord('sub/a.mjs', control ? changed : sources['sub/a.mjs'], true), moduleRecord('sub/dep.mjs', sources['sub/dep.mjs'], true)];
  const edges = [depEdge, missingEdge];
  if (mode === 'all') {
    if (!control) modules.push(moduleRecord('sub/lazy.mjs', sources['sub/lazy.mjs'], false));
    modules.push(moduleRecord('sub/leaf.mjs', sources['sub/leaf.mjs'], false));
    edges.splice(1, 0, control ? changedEdge : lazyEdge);
    if (!control) edges.push(leafEdge);
  }
  return { root: 'sub/a.mjs', mode, modules, edges, unknown: [missingEdge] };
}

test('subgraph report survives source root relocation and detects a changed import', t => {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-relocation-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const first = join(tmp, 'first');
  const second = join(tmp, 'nested', 'space \u96ea', 'second');
  const sentinel = join(tmp, 'sentinel');
  mkdirSync(join(first, 'sub'), { recursive: true });
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(first, name), content);
  mkdirSync(dirname(second), { recursive: true });
  cpSync(first, second, { recursive: true });
  const snapshot = root => Object.fromEntries(Object.keys(sources).map(name => [name, readFileSync(join(root, name), 'utf8')]));
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  function run(args, input) {
    const result = spawnSync(process.execPath, args, { input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TMPDIR: tmp, SENTINEL: sentinel } });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    JSON.parse(result.stdout);
    return result.stdout;
  }
  function scan(root, report) {
    const output = run([scanner, join(root, 'entry.mjs')]);
    writeFileSync(report, output);
    return output;
  }
  function project(report, mode) {
    return run([subgraph, report, 'sub/a.mjs', mode]);
  }
  const firstReport = join(tmp, 'first-report.json');
  const secondReport = join(tmp, 'second-report.json');
  const beforeFirst = scan(first, firstReport);
  const beforeSecond = scan(second, secondReport);
  assert.equal(beforeFirst, beforeSecond);
  for (const mode of ['eager', 'all']) {
    const a = project(firstReport, mode);
    const b = project(secondReport, mode);
    assert.equal(a, JSON.stringify(expected(mode)) + '\n');
    assert.equal(a, b);
    for (const root of [first, second]) assert.equal(a.includes(root), false);
  }
  assert.equal(readFileSync(firstReport, 'utf8'), beforeFirst);
  assert.equal(readFileSync(secondReport, 'utf8'), beforeSecond);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), sources);
  assert.equal(existsSync(sentinel), false);

  writeFileSync(join(second, 'sub/a.mjs'), changed);
  const controlReport = join(tmp, 'control-report.json');
  const control = scan(second, controlReport);
  for (const mode of ['eager', 'all']) {
    assert.equal(project(controlReport, mode), JSON.stringify(expected(mode, true)) + '\n');
    assert.equal(project(firstReport, mode), JSON.stringify(expected(mode)) + '\n');
  }
  assert.equal(scan(first, join(tmp, 'first-again.json')), beforeFirst);
  assert.equal(readFileSync(firstReport, 'utf8'), beforeFirst);
  assert.equal(readFileSync(secondReport, 'utf8'), beforeSecond);
  assert.equal(readFileSync(controlReport, 'utf8'), control);
  assert.deepEqual(snapshot(first), sources);
  assert.deepEqual(snapshot(second), { ...sources, 'sub/a.mjs': changed });
  assert.equal(existsSync(sentinel), false);
});
