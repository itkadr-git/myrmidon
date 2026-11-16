import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const secret = 'SECRET_SENTINEL_DO_NOT_PRINT';
const fixture = () => ({
  entry: 'entry',
  modules: [
    { path: 'entry', bytes: 1, eager: true },
    { path: 'eager', bytes: 2, eager: true },
    { path: 'lazy', bytes: 3, eager: false },
    { path: secret, bytes: 4, eager: false },
  ],
  edges: [
    { from: 'entry', specifier: 'static', kind: 'eager', to: 'eager' },
    { from: 'entry', specifier: 'dynamic', kind: 'lazy', to: 'lazy' },
    { from: 'lazy', specifier: secret, kind: 'eager', to: secret },
  ],
});

function reject(input, category, args = []) {
  const result = spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
  assert.ok(!result.stderr.includes(secret));
}

test('invalid module and edge shapes are rejected before any DOT output', async t => {
  const cases = [
    ['null module', r => { r.modules[3] = null; }],
    ['array module', r => { r.modules[3] = []; }],
    ['NaN bytes serialized as null', r => { r.modules[3].bytes = NaN; }],
    ['negative bytes', r => { r.modules[3].bytes = -1; }],
    ['fractional bytes', r => { r.modules[3].bytes = 1.5; }],
    ['unsafe bytes', r => { r.modules[3].bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['nonboolean eager', r => { r.modules[3].eager = 'false'; }],
    ['duplicate module', r => { r.modules[3].path = 'lazy'; }],
    ['null edge', r => { r.edges[2] = null; }],
    ['array edge', r => { r.edges[2] = []; }],
    ['invalid kind', r => { r.edges[2].kind = 'invalid'; }],
    ['missing from field', r => { delete r.edges[2].from; }],
    ['missing target field', r => { delete r.edges[2].to; }],
    ['missing entry field', r => { delete r.entry; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const report = fixture();
    mutate(report);
    reject(JSON.stringify(report), 'shape');
  });
});

test('invalid graph references and eager flags are rejected before any DOT output', async t => {
  const cases = [
    ['missing from module', r => { r.edges[2].from = 'absent'; }],
    ['missing target module', r => { r.edges[2].to = 'absent'; }],
    ['missing entry module', r => { r.entry = 'absent'; }],
    ['duplicate exact tuple', r => { r.edges.push({ ...r.edges[2] }); }],
    ['reachable module marked lazy', r => { r.modules[1].eager = false; }],
    ['lazy module marked eager', r => { r.modules[2].eager = true; }],
    ['disconnected from eager graph marked eager', r => { r.modules[3].eager = true; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const report = fixture();
    mutate(report);
    reject(JSON.stringify(report), 'graph');
  });
});

test('arguments take precedence over invalid JSON without leaking input', () => {
  reject(`{${secret}`, 'argv', ['unexpected']);
});
