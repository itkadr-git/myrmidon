import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = process.env.MYRMIDON_SHORTEST_CLI ?? fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const sentinel = 'synthetic-secret-sentinel';
const base = () => ({ entry: sentinel, modules: [
  { path: sentinel, bytes: 1, eager: true },
  { path: 'reachable', bytes: 2, eager: true },
  { path: 'disconnected', bytes: 3, eager: false },
], edges: [{ from: sentinel, to: 'reachable', specifier: './reachable', kind: 'eager' }] });
const change = fn => { const report = base(); fn(report); return report; };
const cases = [
  ['report null', 'shape', null], ['report array', 'shape', []], ['report string', 'shape', 'bad'],
  ['missing entry', 'shape', change(r => { delete r.entry; })],
  ['empty entry', 'shape', change(r => { r.entry = ''; })],
  ['entry type', 'shape', change(r => { r.entry = 1; })],
  ['missing modules', 'shape', change(r => { delete r.modules; })],
  ['modules object', 'shape', change(r => { r.modules = {}; })],
  ['modules empty', 'shape', change(r => { r.modules = []; })],
  ['missing edges', 'shape', change(r => { delete r.edges; })],
  ['edges object', 'shape', change(r => { r.edges = {}; })],
  ['module null', 'shape', change(r => { r.modules[2] = null; })],
  ['module array', 'shape', change(r => { r.modules[2] = []; })],
  ['module missing path', 'shape', change(r => { delete r.modules[2].path; })],
  ['module empty path', 'shape', change(r => { r.modules[2].path = ''; })],
  ['module path type', 'shape', change(r => { r.modules[2].path = 1; })],
  ['module missing bytes', 'shape', change(r => { delete r.modules[2].bytes; })],
  ['module negative bytes', 'shape', change(r => { r.modules[2].bytes = -1; })],
  ['module fractional bytes', 'shape', change(r => { r.modules[2].bytes = 1.5; })],
  ['module unsafe bytes', 'shape', change(r => { r.modules[2].bytes = Number.MAX_SAFE_INTEGER + 1; })],
  ['module bytes type', 'shape', change(r => { r.modules[2].bytes = '3'; })],
  ['module missing eager', 'shape', change(r => { delete r.modules[2].eager; })],
  ['module eager type', 'shape', change(r => { r.modules[2].eager = 'false'; })],
  ['edge null', 'shape', change(r => { r.edges.push(null); })],
  ['edge array', 'shape', change(r => { r.edges.push([]); })],
  ['edge missing from', 'shape', change(r => { r.edges.push({ to: null, kind: 'lazy', specifier: 'x' }); })],
  ['edge empty from', 'shape', change(r => { r.edges.push({ from: '', to: null, kind: 'lazy', specifier: 'x' }); })],
  ['edge missing to', 'shape', change(r => { r.edges.push({ from: 'disconnected', kind: 'lazy', specifier: 'x' }); })],
  ['edge empty to', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: '', kind: 'lazy', specifier: 'x' }); })],
  ['edge to type', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: 1, kind: 'lazy', specifier: 'x' }); })],
  ['edge missing kind', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: null, specifier: 'x' }); })],
  ['edge unknown kind', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: null, kind: 'other', specifier: 'x' }); })],
  ['edge missing specifier', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: null, kind: 'lazy' }); })],
  ['edge specifier type', 'shape', change(r => { r.edges.push({ from: 'disconnected', to: null, kind: 'lazy', specifier: 1 }); })],
  ['duplicate path disconnected', 'graph', change(r => { r.modules.push({ ...r.modules[2] }); })],
  ['entry absent from modules', 'graph', change(r => { r.entry = 'missing'; })],
  ['dangling from disconnected', 'graph', change(r => { r.edges.push({ from: 'missing', to: 'disconnected', kind: 'lazy', specifier: 'x' }); })],
  ['dangling to disconnected', 'graph', change(r => { r.edges.push({ from: 'disconnected', to: 'missing', kind: 'lazy', specifier: 'x' }); })],
  ['duplicate edge disconnected', 'graph', change(r => { const e = { from: 'disconnected', to: 'disconnected', kind: 'lazy', specifier: 'x' }; r.edges.push(e, { ...e }); })],
  ['entry eager false', 'graph', change(r => { r.modules[0].eager = false; })],
  ['reachable eager false', 'graph', change(r => { r.modules[1].eager = false; })],
  ['unreachable eager true', 'graph', change(r => { r.modules[2].eager = true; })],
];

for (const [name, category, report] of cases) {
  test(name, () => {
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
    assert.ok(!result.stderr.includes(sentinel));
  });
}
