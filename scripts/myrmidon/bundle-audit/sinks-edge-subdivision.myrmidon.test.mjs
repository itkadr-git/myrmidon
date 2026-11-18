import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const mod = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, to, kind, specifier) => ({ from, to, kind, specifier });
const invoke = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });

function check(report, expected) {
  const original = JSON.stringify(report);
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = invoke(input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  }
  assert.equal(JSON.stringify(report), original);
}

const chain = {
  entry: 'a',
  modules: [mod('a', 2, true), mod('b', 3, true), mod('c', 7, true), mod('lazy', 11, false)],
  edges: [edge('a', 'b', 'eager', './b'), edge('b', 'c', 'eager', './c'), edge('a', 'lazy', 'lazy', './lazy'), edge('b', null, 'eager', 'external')],
};
const chainSplit = {
  ...chain,
  modules: [...chain.modules, mod('x', 0, true)],
  edges: [edge('a', 'x', 'eager', './x'), edge('x', 'b', 'eager', './b-via-x'), ...chain.edges.slice(1)],
};
const chainExpected = { entry: 'a', sinks: [{ path: 'c', bytes: 7 }], sinkBytes: 7 };

test('subdividing an eager chain preserves its terminal and bytes', () => {
  check(chain, chainExpected);
  check(chainSplit, chainExpected);
});

test('subdividing one diamond branch preserves both terminals and shared sink', () => {
  const base = {
    entry: 'root',
    modules: [mod('root', 1, true), mod('left', 2, true), mod('right', 3, true), mod('shared', 5, true), mod('other', 13, true), mod('idle', 17, false)],
    edges: [edge('root', 'left', 'eager', './left'), edge('root', 'right', 'eager', './right'), edge('left', 'shared', 'eager', './shared-left'), edge('right', 'shared', 'eager', './shared-right'), edge('right', 'other', 'eager', './other'), edge('root', 'idle', 'lazy', './idle'), edge('left', null, 'eager', 'external-left')],
  };
  const split = { ...base, modules: [...base.modules, mod('bridge', 0, true)], edges: [...base.edges.slice(0, 2), edge('left', 'bridge', 'eager', './bridge'), edge('bridge', 'shared', 'eager', './shared-bridge'), ...base.edges.slice(3)] };
  const expected = { entry: 'root', sinks: [{ path: 'other', bytes: 13 }, { path: 'shared', bytes: 5 }], sinkBytes: 18 };
  check(base, expected);
  check(split, expected);
});

test('subdividing a lazy edge leaves its intermediary unreachable', () => {
  const base = {
    entry: 'entry',
    modules: [mod('entry', 1, true), mod('terminal', 9, true), mod('deferred', 20, false)],
    edges: [edge('entry', 'terminal', 'eager', './terminal'), edge('entry', 'deferred', 'lazy', './deferred'), edge('terminal', null, 'eager', 'external-terminal')],
  };
  const split = { ...base, modules: [...base.modules, mod('bridge', 0, false)], edges: [base.edges[0], edge('entry', 'bridge', 'lazy', './bridge'), edge('bridge', 'deferred', 'eager', './deferred-bridge'), base.edges[2]] };
  const expected = { entry: 'entry', sinks: [{ path: 'terminal', bytes: 9 }], sinkBytes: 9 };
  check(base, expected);
  check(split, expected);
});

test('a self-loop removes the reachable terminal from sinks', () => {
  const loop = { ...chainSplit, edges: [...chainSplit.edges, edge('c', 'c', 'eager', './self')] };
  check(loop, { entry: 'a', sinks: [], sinkBytes: 0 });
});

test('a subdivided graph with a missing endpoint is rejected', () => {
  const broken = { ...chainSplit, modules: chainSplit.modules.filter(module => module.path !== 'x') };
  const result = invoke(broken);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
});
