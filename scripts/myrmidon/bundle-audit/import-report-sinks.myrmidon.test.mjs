import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const mod = (path, bytes = 1) => ({ path, bytes, eager: false });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unknown') => ({ from, to, kind, specifier });
const report = (modules, edges = []) => ({ entry: modules[0].path, modules, edges });
function run(input, args = [], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', cwd });
}
function success(r, sinks, sinkBytes) {
  const result = run(JSON.stringify(r));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ entry: r.entry, sinks, sinkBytes }) + '\n');
}
function failure(input, category, args = []) {
  const result = run(input, args);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, category + '\n');
  assert.ok(!result.stderr.includes('SECRET_SENTINEL'));
}

test('isolated entry and chain', () => {
  success(report([mod('a', 3)]), [{ path: 'a', bytes: 3 }], 3);
  success(report([mod('a'), mod('b', 4), mod('c', 9)], [edge('a','b'), edge('b','c')]), [{ path: 'c', bytes: 9 }], 9);
});
test('diamond counts shared sink once and ignores disconnected vertices', () => {
  const r = report([mod('a'), mod('b'), mod('c'), mod('d', 7), mod('z', 20)], [edge('a','b'), edge('a','c'), edge('b','d'), edge('c','d')]);
  success(r, [{ path: 'd', bytes: 7 }], 7);
  success({ ...r, modules: [...r.modules].reverse(), edges: [...r.edges].reverse() }, [{ path: 'd', bytes: 7 }], 7);
});
test('cycles, self loops, lazy and unknown edges', () => {
  const nodes = [mod('a'), mod('b'), mod('c', 5)];
  success(report(nodes, [edge('a','b'), edge('b','a')]), [], 0);
  success(report(nodes, [edge('a','b'), edge('b','a'), edge('b','c')]), [{ path: 'c', bytes: 5 }], 5);
  success(report([mod('a')], [edge('a','a')]), [], 0);
  success(report(nodes, [edge('a','b','lazy'), edge('a',null)]), [{ path: 'a', bytes: 1 }], 1);
  success(report(nodes, [edge('a','c'), edge('a','b')]), [{ path: 'b', bytes: 1 }, { path: 'c', bytes: 5 }], 6);
});
test('error categories and safe sum overflow', () => {
  failure('{}', 'argv', ['SECRET_SENTINEL']);
  failure('{SECRET_SENTINEL', 'json');
  failure(JSON.stringify({ entry: 'SECRET_SENTINEL' }), 'shape');
  failure(JSON.stringify(report([mod('a'), mod('a')])), 'graph');
  failure(JSON.stringify(report([mod('a')], [edge('a','SECRET_SENTINEL')])), 'graph');
  failure(JSON.stringify(report([mod('a')], [edge('a',null), edge('a',null)])), 'graph');
  failure(JSON.stringify(report([mod('a'), mod('b', Number.MAX_SAFE_INTEGER), mod('c')], [edge('a','b'), edge('a','c')])), 'graph');
  failure(JSON.stringify({ entry: 'missing', modules: [mod('a')], edges: [] }), 'graph');
  failure(JSON.stringify(report([{ path: 'a', bytes: -1, eager: true }])), 'shape');
  failure(JSON.stringify(report([{ path: 'a', bytes: 1 }])), 'shape');
  failure(JSON.stringify(report([{ path: 'a', bytes: 1, eager: 'yes' }])), 'shape');
  failure(JSON.stringify(report([{ path: 'a', bytes: 1.5, eager: false }])), 'shape');
  failure(JSON.stringify(report([{ path: 'a', bytes: Number.MAX_SAFE_INTEGER + 1, eager: false }])), 'shape');
  failure(JSON.stringify(report([mod('a'), { path: '', bytes: 1, eager: false }])), 'shape');
  failure(JSON.stringify(report([mod('a')], [{ from: '', to: null, kind: 'eager', specifier: 'x' }])), 'shape');
  failure(JSON.stringify(report([mod('a')], [{ from: 'a', to: null, kind: 'eager' }])), 'shape');
  failure(JSON.stringify(report([mod('a')], [{ from: 'a', to: null, kind: 'side-effect', specifier: 'x' }])), 'shape');
  failure(JSON.stringify(report([mod('a')], [{ from: 'a', to: 7, kind: 'eager', specifier: 'x' }])), 'shape');
  failure(JSON.stringify(report([mod('a')], [{ from: 'missing', to: null, kind: 'eager', specifier: 'x' }])), 'graph');
});
test('stdin chunks and absolute CLI work from another cwd', async () => {
  const r = report([mod('a', 2)]);
  const child = spawn(process.execPath, [cli], { cwd: process.env.HOME, stdio: ['pipe','pipe','pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', chunk => out += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => err += chunk);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const input = JSON.stringify(r); child.stdin.write(input.slice(0, 5)); child.stdin.end(input.slice(5));
  assert.equal(await done, 0);
  assert.equal(err, '');
  assert.equal(out, JSON.stringify({ entry: 'a', sinks: [{ path: 'a', bytes: 2 }], sinkBytes: 2 }) + '\n');
});
