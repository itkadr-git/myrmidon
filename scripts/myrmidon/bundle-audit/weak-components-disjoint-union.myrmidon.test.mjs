import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const m = (path, bytes, eager = false) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});
const success = (report, mode, expected) => {
  const result = run(report, mode);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
};

const pairs = [
  {
    a: {entry:'a', modules:[m('a',2,true),m('c',3)], edges:[e('c','a','eager','a')]},
    b: {entry:'b', modules:[m('b',5,true),m('d',7),m('e',11)], edges:[e('b','d','lazy','d'),e('d','e','eager','e')]},
    eagerA: {entry:'a',components:[{id:'a',paths:['a','c'],bytes:5}]},
    allA: {entry:'a',components:[{id:'a',paths:['a','c'],bytes:5}]},
    eagerB: {entry:'b',components:[{id:'b',paths:['b'],bytes:5},{id:'d',paths:['d','e'],bytes:18}]},
    allB: {entry:'b',components:[{id:'b',paths:['b','d','e'],bytes:23}]},
    eagerUnion: {entry:'a',components:[{id:'a',paths:['a','c'],bytes:5},{id:'b',paths:['b'],bytes:5},{id:'d',paths:['d','e'],bytes:18}]},
    allUnion: {entry:'a',components:[{id:'a',paths:['a','c'],bytes:5},{id:'b',paths:['b','d','e'],bytes:23}]},
  },
  {
    a: {entry:'z', modules:[m('z',9007199254740991,true)], edges:[]},
    b: {entry:'q', modules:[m('q',9007199254740990,true),m('r',1)], edges:[e('q','r','eager','r')]},
    eagerA: {entry:'z',components:[{id:'z',paths:['z'],bytes:9007199254740991}]},
    allA: {entry:'z',components:[{id:'z',paths:['z'],bytes:9007199254740991}]},
    eagerB: {entry:'q',components:[{id:'q',paths:['q','r'],bytes:9007199254740991}]},
    allB: {entry:'q',components:[{id:'q',paths:['q','r'],bytes:9007199254740991}]},
    eagerUnion: {entry:'z',components:[{id:'q',paths:['q','r'],bytes:9007199254740991},{id:'z',paths:['z'],bytes:9007199254740991}]},
    allUnion: {entry:'z',components:[{id:'q',paths:['q','r'],bytes:9007199254740991},{id:'z',paths:['z'],bytes:9007199254740991}]},
  },
  {
    a: {entry:'x', modules:[m('x',0,true),m('w',4)], edges:[e('x','w','eager','w')]},
    b: {entry:'v', modules:[m('v',8,true),m('t',9),m('u',1)], edges:[e('u','v','eager','v')]},
    eagerA: {entry:'x',components:[{id:'w',paths:['w','x'],bytes:4}]},
    allA: {entry:'x',components:[{id:'w',paths:['w','x'],bytes:4}]},
    eagerB: {entry:'v',components:[{id:'t',paths:['t'],bytes:9},{id:'u',paths:['u','v'],bytes:9}]},
    allB: {entry:'v',components:[{id:'t',paths:['t'],bytes:9},{id:'u',paths:['u','v'],bytes:9}]},
    eagerUnion: {entry:'x',components:[{id:'t',paths:['t'],bytes:9},{id:'u',paths:['u','v'],bytes:9},{id:'w',paths:['w','x'],bytes:4}]},
    allUnion: {entry:'x',components:[{id:'t',paths:['t'],bytes:9},{id:'u',paths:['u','v'],bytes:9},{id:'w',paths:['w','x'],bytes:4}]},
  },
];

test('disjoint graphs preserve their exact components in eager and all modes', () => {
  for (const pair of pairs) {
    const snapshot = JSON.stringify(pair);
    const union = {entry:pair.a.entry, modules:[...pair.a.modules,...pair.b.modules], edges:[...pair.a.edges,...pair.b.edges]};
    const permuted = {...union, modules:[...union.modules].reverse(), edges:[...union.edges].reverse()};
    for (const [mode, expectedA, expectedB, expectedUnion] of [
      ['eager',pair.eagerA,pair.eagerB,pair.eagerUnion],
      ['all',pair.allA,pair.allB,pair.allUnion],
    ]) {
      success(pair.a, mode, expectedA);
      success(pair.b, mode, expectedB);
      success(union, mode, expectedUnion);
      success(permuted, mode, expectedUnion);
      success(union, mode, expectedUnion);
      success({...union, entry:pair.b.entry}, mode, {...expectedUnion, entry:pair.b.entry});
    }
    assert.equal(JSON.stringify(pair), snapshot);
  }
});

test('missing edge endpoint is rejected without disclosing the payload', () => {
  const secret = 'private-endpoint-sentinel';
  const invalid = {entry:'a', modules:[m('a',1,true)], edges:[e('a','link','eager',secret)]};
  const result = run(invalid, 'all');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
  assert.ok(!result.stderr.includes(secret));
});
