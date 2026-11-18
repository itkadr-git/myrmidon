import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const moduleOf = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const row = (path, bytes, targets, fanOut) => ({ path, bytes, targets, fanOut });
const result = modules => ({ entry: 'e', modules });
const run = report => spawnSync(process.execPath, [cli], {
  cwd: homedir(), input: JSON.stringify(report), encoding: 'utf8',
});
function verify(report, expected) {
  for (const input of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    const actual = run(input);
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stderr, '');
    assert.equal(actual.stdout, JSON.stringify(expected) + '\n');
  }
}
function without(report, specifiers, eagerPaths) {
  return { ...report, modules: report.modules.map(mod => ({ ...mod, eager: eagerPaths.includes(mod.path) })),
    edges: report.edges.filter(item => !specifiers.includes(item.specifier)).map(item => ({ ...item })) };
}
function contract(before, stages, baseline) {
  const original = JSON.stringify(before);
  verify(before, baseline);
  for (const [removed, eager, expected] of stages) verify(without(before, removed, eager), expected);
  assert.equal(JSON.stringify(before), original);
  verify(before, baseline);
}

test('removing a direct edge preserves modules and reranks tied sources', () => {
  const before = { entry: 'e', modules: [moduleOf('e', 10, true), moduleOf('a', 20, true), moduleOf('b', 30, true)],
    edges: [edge('e','ea','eager','a'), edge('e','eb','eager','b'), edge('a','ab','eager','b')] };
  const baseline = result([row('e',10,['a','b'],2), row('a',20,['b'],1), row('b',30,[],0)]);
  const after = result([row('a',20,['b'],1), row('e',10,['a'],1), row('b',30,[],0)]);
  contract(before, [[['eb'], ['e','a','b'], after]], baseline);
});

test('removing aliases one at a time only removes the final target', () => {
  const before = { entry: 'e', modules: [moduleOf('e',10,true), moduleOf('a',20,true), moduleOf('b',30,true)],
    edges: [edge('e','first','eager','b'), edge('e','second','eager','b'), edge('e','ea','eager','a'), edge('a','ab','eager','b')] };
  const baseline = result([row('e',10,['a','b'],2), row('a',20,['b'],1), row('b',30,[],0)]);
  const after = result([row('a',20,['b'],1), row('e',10,['a'],1), row('b',30,[],0)]);
  contract(before, [[['first'], ['e','a','b'], baseline], [['first','second'], ['e','a','b'], after]], baseline);
});

test('self loop removal retains other targets and recomputes eager reachability', () => {
  const before = { entry: 'e', modules: [moduleOf('e',10,true), moduleOf('a',20,true), moduleOf('b',30,true)],
    edges: [edge('e','ea','eager','a'), edge('a','self','eager','a'), edge('a','ab','eager','b')] };
  const baseline = result([row('a',20,['a','b'],2), row('e',10,['a'],1), row('b',30,[],0)]);
  const after = result([row('a',20,['b'],1), row('e',10,['a'],1), row('b',30,[],0)]);
  contract(before, [[['self'], ['e','a','b'], after]], baseline);
});

test('lazy and unknown removals are inert; disconnected removal changes only its source', () => {
  const before = { entry: 'e', modules: [moduleOf('e',10,true), moduleOf('a',20,true), moduleOf('x',30,false), moduleOf('y',40,false)],
    edges: [edge('e','ea','eager','a'), edge('e','lazy','lazy','x'), edge('e','unknown','eager',null), edge('x','xy','eager','y')] };
  const baseline = result([row('e',10,['a'],1), row('x',30,['y'],1), row('a',20,[],0), row('y',40,[],0)]);
  const after = result([row('e',10,['a'],1), row('a',20,[],0), row('x',30,[],0), row('y',40,[],0)]);
  contract(before, [[['lazy'], ['e','a'], baseline], [['unknown'], ['e','a'], baseline], [['lazy','unknown','xy'], ['e','a'], after]], baseline);
});

test('last path removal marks an unreachable module non-eager without deleting it', () => {
  const before = { entry: 'e', modules: [moduleOf('e',10,true), moduleOf('a',20,true), moduleOf('b',30,true)],
    edges: [edge('e','ea','eager','a'), edge('a','ab','eager','b')] };
  const baseline = result([row('a',20,['b'],1), row('e',10,['a'],1), row('b',30,[],0)]);
  const after = result([row('e',10,['a'],1), row('a',20,[],0), row('b',30,[],0)]);
  contract(before, [[['ab'], ['e','a'], after]], baseline);
});

test('missing edge endpoint fails without disclosing input paths', () => {
  const report = { entry: 'private-entry', modules: [moduleOf('private-entry',1,true)],
    edges: [edge('private-entry','missing','eager','private-target')] };
  const actual = run(report);
  assert.notEqual(actual.status, 0);
  assert.equal(actual.stdout, '');
  assert.equal(actual.stderr, 'graph\n');
  assert.ok(!actual.stderr.includes('private-entry'));
  assert.ok(!actual.stderr.includes('private-target'));
});
