import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, to) => ({ from, specifier: to, kind: 'eager', to });
const cases = [
  {
    a: { entry: 'a0', modules: [m('a0', 1, true), m('a1', 2, true), m('a2', 3, true), m('a3', 4, true)], edges: [e('a0','a1'), e('a0','a2'), e('a1','a3'), e('a2','a3')] },
    b: { entry: 'b0', modules: [m('b0', 5, true), m('b1', 6, true), m('b2', 7, true)], edges: [e('b0','b1'), e('b1','b2'), e('b2','b1')] },
    removeA: 'a1', removeB: 'b1',
    expectedA: { entry:'a0', removed:'a1', lostPaths:['a1'], lostBytes:2 },
    expectedB: { entry:'b0', removed:'b1', lostPaths:['b1','b2'], lostBytes:13 },
    expectedUnionA: { entry:'a0', removed:'a1', lostPaths:['a1'], lostBytes:2 },
    expectedUnionB: { entry:'a0', removed:'b1', lostPaths:[], lostBytes:0 },
    expectedUnionEntryB: { entry:'b0', removed:'b1', lostPaths:['b1','b2'], lostBytes:13 },
  },
  {
    a: { entry:'c0', modules:[m('c0',10,true),m('c1',11,true),m('c2',12,true)], edges:[e('c0','c1'),e('c1','c2')] },
    b: { entry:'d0', modules:[m('d0',13,true),m('d1',14,true)], edges:[e('d0','d1')] },
    removeA:'c1', removeB:'d0',
    expectedA:{entry:'c0',removed:'c1',lostPaths:['c1','c2'],lostBytes:23},
    expectedB:{entry:'d0',removed:'d0',lostPaths:['d0','d1'],lostBytes:27},
    expectedUnionA:{entry:'c0',removed:'c1',lostPaths:['c1','c2'],lostBytes:23},
    expectedUnionB:{entry:'c0',removed:'d0',lostPaths:[],lostBytes:0},
    expectedUnionEntryB:{entry:'d0',removed:'d0',lostPaths:['d0','d1'],lostBytes:27},
  },
  {
    a:{entry:'e0',modules:[m('e0',3,true),m('e1',0,true)],edges:[e('e0','e1')]},
    b:{entry:'f0',modules:[m('f0',8,true),m('f1',9,true),m('f2',10,true)],edges:[e('f0','f1'),e('f0','f2')]},
    removeA:'e0', removeB:'f1',
    expectedA:{entry:'e0',removed:'e0',lostPaths:['e0','e1'],lostBytes:3},
    expectedB:{entry:'f0',removed:'f1',lostPaths:['f1'],lostBytes:9},
    expectedUnionA:{entry:'e0',removed:'e0',lostPaths:['e0','e1'],lostBytes:3},
    expectedUnionB:{entry:'e0',removed:'f1',lostPaths:[],lostBytes:0},
    expectedUnionEntryB:{entry:'f0',removed:'f1',lostPaths:['f1'],lostBytes:9},
  },
];

function run(report, removed) {
  return spawnSync(process.execPath, [cli, removed], { input:JSON.stringify(report), encoding:'utf8', cwd:homedir(), timeout:10000 });
}
function success(report, removed, expected) {
  const result = run(report, removed);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}

test('disjoint union preserves independent cut impacts for three graph pairs', () => {
  for (const {a,b,removeA,removeB,expectedA,expectedB,expectedUnionA,expectedUnionB,expectedUnionEntryB} of cases) {
    const before = JSON.stringify({a,b});
    const union = {entry:a.entry, modules:[...a.modules, ...b.modules.map(module => ({...module,eager:false}))], edges:[...a.edges,...b.edges]};
    const withEntryB = {entry:b.entry, modules:[...a.modules.map(module => ({...module,eager:false})),...b.modules], edges:union.edges};
    success(a, removeA, expectedA);
    success(b, removeB, expectedB);
    for (const report of [union, {...union,modules:[...union.modules].reverse(),edges:[...union.edges].reverse()}]) {
      success(report, removeA, expectedUnionA);
      success(report, removeB, expectedUnionB);
      success(report, removeA, expectedUnionA);
    }
    success(withEntryB, removeB, expectedUnionEntryB);
    success({...withEntryB,modules:[...withEntryB.modules].reverse(),edges:[...withEntryB.edges].reverse()}, removeB, expectedUnionEntryB);
    assert.equal(JSON.stringify({a,b}), before);
  }
});

test('unknown removal and missing edge endpoint use sanitized error categories', () => {
  const unknown = run(cases[0].a, 'missing');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, 'argv\n');
  const sentinel = 'synthetic-private-payload';
  const invalid = {...cases[0].a, edges:[...cases[0].a.edges, e('a0',sentinel)]};
  const result = run(invalid, 'a1');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes(sentinel));
});
