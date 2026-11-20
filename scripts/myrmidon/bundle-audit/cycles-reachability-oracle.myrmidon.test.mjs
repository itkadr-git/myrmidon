import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-cycles.mjs');
const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const edge = (from, to, kind = 'eager', specifier = String(to)) => ({ from, to, kind, specifier });

function oracle(report, eagerOnly) {
  const names = report.modules.map(m => m.path);
  const reach = names.map(() => names.map(() => false));
  for (const e of report.edges) {
    if (e.to !== null && (!eagerOnly || e.kind === 'eager')) {
      reach[names.indexOf(e.from)][names.indexOf(e.to)] = true;
    }
  }
  for (let k = 0; k < names.length; k++)
    for (let i = 0; i < names.length; i++)
      for (let j = 0; j < names.length; j++)
        reach[i][j] ||= reach[i][k] && reach[k][j];
  const assigned = new Set();
  const result = [];
  for (let i = 0; i < names.length; i++) {
    if (assigned.has(i)) continue;
    const members = names.map((_, j) => j).filter(j => j === i || (reach[i][j] && reach[j][i]));
    for (const j of members) assigned.add(j);
    if (members.length > 1 || reach[i][i]) result.push(members.map(j => names[j]).sort(compare));
  }
  return result.sort((a, b) => compare(a[0], b[0]));
}

function graph(seed) {
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const names = ['z', 'A', 'a', 'Z', 'b', 'B', '0', 'x', 'Y'].slice(0, 2 + seed % 8);
  const edges = [];
  for (const from of names) for (const to of names) {
    if (random() % 5 === 0) edges.push(edge(from, to, random() % 2 ? 'eager' : 'lazy'));
  }
  return { entry: names[0], modules: names.map((path, i) => ({ path, bytes: i, eager: i % 2 === 0 })), edges };
}

function check(t, report) {
  const dir = mkdtempSync(join(root, 'reachability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  const expected = JSON.stringify({ entry: report.entry, eagerCycles: oracle(report, true), allCycles: oracle(report, false) }) + '\n';
  for (const input of [report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    writeFileSync(file, JSON.stringify(input));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, expected);
  }
}

test('seeded graphs match mutual reachability in both input orders', async t => {
  for (let seed = 1; seed <= 30; seed++) {
    await t.test(`seed ${seed}`, t => check(t, graph(seed)));
  }
});

test('diamond, disconnected components, lazy return, self-loop and parallel edges', t => {
  const names = ['z', 'A', 'a', 'Z', 'b', 'B', '0', 'x', 'Y'];
  const report = {
    entry: 'z', modules: names.map(path => ({ path, bytes: 0, eager: false })),
    edges: [edge('z', 'A'), edge('z', 'a'), edge('A', 'Z'), edge('a', 'Z'),
      edge('b', 'B'), edge('B', 'b'), edge('0', 'x'), edge('x', '0', 'lazy'),
      edge('Y', 'Y'), edge('b', 'B', 'eager', 'parallel'), edge('z', null)],
  };
  check(t, report);
});
