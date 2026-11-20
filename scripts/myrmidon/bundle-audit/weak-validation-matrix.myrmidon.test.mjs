import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const cli = join(directory, 'import-report-weak-components.mjs');
const sentinel = 'synthetic-validation-sentinel';
const fixture = () => ({
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 1, eager: true }, { path: 'island', bytes: 2, eager: false }, { path: sentinel, bytes: 3, eager: false }],
  edges: [{ from: 'entry', specifier: 'external', kind: 'eager', to: null }, { from: 'island', specifier: sentinel, kind: 'lazy', to: sentinel }],
});
const run = (value, mode) => spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(value), encoding: 'utf8', cwd: homedir(), timeout: 10000 });

const cases = [
  ['null report', 'shape', () => null],
  ['array report', 'shape', () => []],
  ...[null, 7, ''].map(value => [`entry ${JSON.stringify(value)}`, 'shape', r => ({ ...r, entry: value })]),
  ...[null, {}, []].map(value => [`modules ${JSON.stringify(value)}`, 'shape', r => ({ ...r, modules: value })]),
  ...[null, {}].map(value => [`edges ${JSON.stringify(value)}`, 'shape', r => ({ ...r, edges: value })]),
  ...[null, [], 'bad'].map(value => [`module ${JSON.stringify(value)}`, 'shape', r => { r.modules[2] = value; return r; }]),
  ...[['path', ''], ['path', 1], ['bytes', -1], ['bytes', 1.5], ['bytes', '3'], ['bytes', Number.MAX_SAFE_INTEGER + 1], ['eager', 0], ['eager', null]].map(([field, value]) => [`module ${field} ${JSON.stringify(value)}`, 'shape', r => { r.modules[2][field] = value; return r; }]),
  ...[null, [], 'bad'].map(value => [`edge ${JSON.stringify(value)}`, 'shape', r => { r.edges[1] = value; return r; }]),
  ...[['from', ''], ['from', 1], ['specifier', null], ['specifier', 1], ['kind', 'other'], ['kind', null], ['to', ''], ['to', 1]].map(([field, value]) => [`edge ${field} ${JSON.stringify(value)}`, 'shape', r => { r.edges[1][field] = value; return r; }]),
  ['duplicate module path', 'graph', r => { r.modules.push({ ...r.modules[1] }); return r; }],
  ['missing entry', 'graph', r => ({ ...r, entry: 'missing' })],
  ['dangling from', 'graph', r => { r.edges[1].from = 'missing'; return r; }],
  ['dangling to', 'graph', r => { r.edges[1].to = 'missing'; return r; }],
  ['duplicate edge', 'graph', r => { r.edges.push({ ...r.edges[1] }); return r; }],
];

for (const [label, category, mutate] of cases) {
  test(`reject ${label} in both modes`, () => {
    for (const mode of ['eager', 'all']) {
      const result = run(mutate(fixture()), mode);
      assert.equal(result.status, 1, `${label} ${mode}: ${result.stderr}`);
      assert.equal(result.stdout, '', `${label} ${mode} stdout`);
      assert.equal(result.stderr, `${category}\n`, `${label} ${mode} stderr`);
      assert.ok(!result.stderr.includes(sentinel));
    }
  });
}

test('valid alias tuples remain distinct in both modes', () => {
  const value = fixture();
  value.edges.push({ from: 'island', specifier: 'alias', kind: 'lazy', to: sentinel });
  const expected = {
    eager: { entry: 'entry', components: [{ id: 'entry', paths: ['entry'], bytes: 1 }, { id: 'island', paths: ['island'], bytes: 2 }, { id: sentinel, paths: [sentinel], bytes: 3 }] },
    all: { entry: 'entry', components: [{ id: 'entry', paths: ['entry'], bytes: 1 }, { id: 'island', paths: ['island', sentinel], bytes: 5 }] },
  };
  for (const mode of ['eager', 'all']) {
    const result = run(value, mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(expected[mode])}\n`);
  }
});

for (const [label, check, replacement] of [
  ['dangling to', "    if (!modules.has(edge.from) || (edge.to !== null && !modules.has(edge.to))) fail('graph');", "    if (edge.to !== null && !modules.has(edge.to)) continue;\n    if (!modules.has(edge.from)) fail('graph');"],
  ['duplicate module path', "    if (modules.has(mod.path)) fail('graph');", ''],
]) test(`negative control detects skipped ${label} validation`, { skip: process.env.MYRMIDON_WEAK_MUTANT === '1' }, () => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-matrix-'));
  try {
    const original = readFileSync(cli, 'utf8');
    assert.ok(original.includes(check), 'mutation target must exist');
    const mutant = original.replace(check, replacement);
    writeFileSync(join(scratch, 'import-report-weak-components.mjs'), mutant);
    const matrix = join(scratch, 'weak-validation-matrix.myrmidon.test.mjs');
    copyFileSync(fileURLToPath(import.meta.url), matrix);
    const env = { ...process.env, MYRMIDON_WEAK_MUTANT: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=reject ${label}`, matrix], {
      encoding: 'utf8', timeout: 30000, env,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`not ok`) && result.stdout.includes(`reject ${label}`));
    assert.ok(result.stdout.includes(`${label} eager`));
    assert.match(result.stdout, /expected: 1/);
    assert.match(result.stdout, /actual: 0/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
