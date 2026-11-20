import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const moduleOf = (path, bytes, eager = true) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager', specifier = to ?? 'unknown') => ({ from, to, kind, specifier });
const expected = (entry, sinks, sinkBytes) => ({ entry, sinks, sinkBytes });
const sink = (path, bytes) => ({ path, bytes });

function check(report, output) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify(output) + '\n');
  }
}

function removal(before, removed, eagerAfter, baseline, afterExpected) {
  const snapshot = JSON.stringify(before);
  const after = {
    ...before,
    modules: before.modules.map(mod => ({ ...mod, eager: eagerAfter.includes(mod.path) })),
    edges: before.edges.filter(item => item !== removed).map(item => ({ ...item })),
  };
  assert.equal(after.modules.length, before.modules.length);
  assert.deepEqual(after.modules.map(({ path, bytes }) => ({ path, bytes })), before.modules.map(({ path, bytes }) => ({ path, bytes })));
  check(before, baseline);
  check(after, afterExpected);
  assert.equal(JSON.stringify(before), snapshot);
  const restored = { ...after, modules: before.modules.map(mod => ({ ...mod })), edges: [...after.edges, { ...removed }] };
  check(restored, baseline);
  assert.equal(JSON.stringify(before), snapshot);
}

test('chain removal makes the middle node the only sink', () => {
  const ab = edge('a', 'b');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 2), moduleOf('b', 4)], edges: [edge('e', 'a'), ab] };
  removal(before, ab, ['e', 'a'], expected('e', [sink('b', 4)], 4), expected('e', [sink('a', 2)], 2));
});

test('diamond removal keeps the shared sink and adds a zero-byte sink in lexical order', () => {
  const at = edge('a', 't');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 0), moduleOf('b', 2), moduleOf('t', 7)], edges: [edge('e', 'a'), edge('e', 'b'), at, edge('b', 't')] };
  removal(before, at, ['e', 'a', 'b', 't'], expected('e', [sink('t', 7)], 7), expected('e', [sink('a', 0), sink('t', 7)], 7));
});

test('removing a reachable self-loop makes it a sink', () => {
  const loop = edge('a', 'a');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 3)], edges: [edge('e', 'a'), loop] };
  removal(before, loop, ['e', 'a'], expected('e', [], 0), expected('e', [sink('a', 3)], 3));
});

test('removing one alias leaves the other import active', () => {
  const alias = edge('e', 'a', 'eager', './alias');
  const before = { entry: 'e', modules: [moduleOf('e', 1), moduleOf('a', 4)], edges: [edge('e', 'a', 'eager', './a'), alias] };
  removal(before, alias, ['e', 'a'], expected('e', [sink('a', 4)], 4), expected('e', [sink('a', 4)], 4));
});

test('removing lazy or unknown imports does not change sinks', () => {
  const lazy = edge('e', 'z', 'lazy');
  const unknown = edge('e', null);
  const before = { entry: 'e', modules: [moduleOf('e', 2), moduleOf('z', 9, false)], edges: [lazy, unknown] };
  const baseline = expected('e', [sink('e', 2)], 2);
  removal(before, lazy, ['e'], baseline, expected('e', [sink('e', 2)], 2));
  removal(before, unknown, ['e'], baseline, expected('e', [sink('e', 2)], 2));
});

test('missing endpoint reports graph without exposing input paths', () => {
  const report = { entry: 'PRIVATE_ENTRY', modules: [moduleOf('PRIVATE_ENTRY', 1)], edges: [edge('PRIVATE_ENTRY', 'PRIVATE_MISSING')] };
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes('PRIVATE_ENTRY'));
  assert.ok(!result.stderr.includes('PRIVATE_MISSING'));
});
