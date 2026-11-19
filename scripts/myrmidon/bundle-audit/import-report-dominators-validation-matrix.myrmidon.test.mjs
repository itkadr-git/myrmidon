import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-dominators.mjs');
const base = {
  entry: 'a',
  modules: [
    { path: 'a', bytes: 1, eager: true },
    { path: 'b', bytes: 0, eager: true },
    { path: 'z', bytes: 0, eager: false },
  ],
  edges: [{ from: 'a', specifier: './b', kind: 'eager', to: 'b' }],
};
const values = [null, false, 0, '', [], {}];
const shape = 'shape';
const graph = 'graph';
const invalid = [];
const add = (name, change, category = shape) => invalid.push({ name, change, category });
for (const value of [null, false, 0, '', []]) add(`report ${JSON.stringify(value)}`, () => value);
for (const field of ['entry', 'modules', 'edges']) {
  for (const value of field === 'entry' ? values : [null, false, 0, '', {}]) {
    add(`${field} ${JSON.stringify(value)}`, r => { r[field] = value; });
  }
  add(`${field} missing`, r => { delete r[field]; });
}
for (const value of [null, false, 0, '', [], {}]) add(`module ${JSON.stringify(value)}`, r => { r.modules[0] = value; });
for (const field of ['path', 'bytes', 'eager']) {
  const bad = field === 'path' ? values : field === 'bytes' ? [null, false, '', [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1] : [null, 0, '', [], {}];
  for (const value of bad) add(`module ${field} ${JSON.stringify(value)}`, r => { r.modules[0][field] = value; });
  add(`module ${field} missing`, r => { delete r.modules[0][field]; });
}
add('duplicate module', r => { r.modules.push({ ...r.modules[0] }); });
for (const value of [null, false, 0, '', [], {}]) add(`edge ${JSON.stringify(value)}`, r => { r.edges[0] = value; });
for (const field of ['from', 'specifier', 'kind', 'to']) {
  const bad = field === 'to' ? [false, 0, '', [], {}] : values;
  for (const value of bad) add(`edge ${field} ${JSON.stringify(value)}`, r => { r.edges[0][field] = value; });
  add(`edge ${field} missing`, r => { delete r.edges[0][field]; });
}
add('unknown kind', r => { r.edges[0].kind = 'other'; });
add('duplicate edge', r => { r.edges.push({ ...r.edges[0] }); }, graph);
add('missing entry', r => { r.entry = 'missing'; }, graph);
add('missing source', r => { r.edges[0].from = 'missing'; }, graph);
add('missing destination', r => { r.edges[0].to = 'missing'; }, graph);
add('reachable eager false', r => { r.modules[1].eager = false; }, graph);
add('disconnected eager true', r => { r.modules[2].eager = true; }, graph);
add('aggregate overflow disconnected', r => { r.modules[2].bytes = Number.MAX_SAFE_INTEGER; });

function run(root, report, target = 'b') {
  const path = join(root, 'report.json');
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [cli, path, target], { encoding: 'utf8', timeout: 10000 });
}
function rootFor(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dominator-matrix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
}

test('validation category matrix', async t => {
  const root = rootFor(t);
  for (const { name, change, category } of invalid) await t.test(name, () => {
    const report = structuredClone(base);
    const replacement = change(report);
    const result = run(root, replacement === undefined ? report : replacement);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  });
});

test('global aggregate and reachability controls', t => {
  const root = rootFor(t);
  const max = structuredClone(base);
  max.modules[2].bytes = Number.MAX_SAFE_INTEGER - 1;
  success(run(root, max), { entry: 'a', target: 'b', dominators: ['a', 'b'] });
  const unreachable = run(root, base, 'z');
  assert.equal(unreachable.status, 1);
  assert.equal(unreachable.stdout, '');
  assert.equal(unreachable.stderr, 'graph\n');
  const isolated = structuredClone(base);
  isolated.edges = [];
  isolated.modules[1].eager = false;
  success(run(root, isolated, 'a'), { entry: 'a', target: 'a', dominators: ['a'] });
});
