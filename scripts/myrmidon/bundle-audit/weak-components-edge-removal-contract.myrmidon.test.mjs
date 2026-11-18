import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const moduleOf = (path, bytes, eager) => ({ path, bytes, eager });
const edge = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const output = (entry, components) => ({ entry, components });
const component = (id, paths, bytes) => ({ id, paths, bytes });
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000,
});

function verify(report, expected) {
  const original = JSON.stringify(report);
  for (const variant of [report, report, { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() }]) {
    for (const mode of ['eager', 'all']) {
      const result = run(variant, mode);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${JSON.stringify(expected[mode])}\n`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.components.flatMap(c => c.paths).length, report.modules.length);
      assert.equal(parsed.components.reduce((sum, c) => sum + c.bytes, 0), report.modules.reduce((sum, m) => sum + m.bytes, 0));
    }
  }
  assert.equal(JSON.stringify(report), original);
}

function remove(report, removed, eagerPaths) {
  return { ...report, modules: report.modules.map(m => ({ ...m, eager: eagerPaths.includes(m.path) })),
    edges: report.edges.filter(e => !removed.includes(e.specifier)).map(e => ({ ...e })) };
}

test('bridge removal splits islands in either orientation and restoration is exact', () => {
  const baseline = { entry: 'a', modules: [moduleOf('a', 1, true), moduleOf('b', 2, true), moduleOf('c', 3, true), moduleOf('d', 4, true)],
    edges: [edge('a','b','ab'), edge('b','c','bridge'), edge('c','d','cd')] };
  const before = { eager: output('a', [component('a',['a','b','c','d'],10)]), all: output('a', [component('a',['a','b','c','d'],10)]) };
  const after = { eager: output('a', [component('a',['a','b'],3), component('c',['c','d'],7)]), all: output('a', [component('a',['a','b'],3), component('c',['c','d'],7)]) };
  const snapshot = JSON.stringify(baseline);
  verify(baseline, before);
  verify(remove(baseline, ['bridge'], ['a','b']), after);
  assert.equal(JSON.stringify(baseline), snapshot);
  verify(baseline, before);
  const reverse = { ...baseline, modules: baseline.modules.map(m => ({ ...m, eager: ['a','b'].includes(m.path) })), edges: baseline.edges.map(e => e.specifier === 'bridge' ? edge('c','b','bridge') : { ...e }) };
  verify(reverse, before);
  verify(remove(reverse, ['bridge'], ['a','b']), after);
  verify(reverse, before);
});

test('cycle and aliases retain connectivity until the last cross edge is removed', () => {
  const baseline = { entry:'a', modules:[moduleOf('a',1,true),moduleOf('b',2,true),moduleOf('c',3,true)], edges:[
    edge('a','b','ab'), edge('b','c','bc'), edge('a','c','direct'), edge('a','c','alias'), edge('c','a','reverse') ] };
  const before = { eager: output('a',[component('a',['a','b','c'],6)]), all: output('a',[component('a',['a','b','c'],6)]) };
  const after = { eager: output('a',[component('a',['a','b'],3),component('c',['c'],3)]), all: output('a',[component('a',['a','b'],3),component('c',['c'],3)]) };
  const snapshot = JSON.stringify(baseline);
  verify(baseline, before);
  verify(remove(baseline,['direct'],['a','b','c']), before);
  verify(remove(baseline,['bc','direct','alias'],['a','b']), before);
  verify(remove(baseline,['bc','direct','alias','reverse'],['a','b']), after);
  assert.equal(JSON.stringify(baseline), snapshot);
  verify(baseline, before);
});

test('lazy bridge, null and self-loop removals preserve vertices and code-unit order', () => {
  const baseline = { entry:'entry', modules:[moduleOf('entry',1,true),moduleOf('Z',2,false),moduleOf('\u00e9',3,false),moduleOf('\ud83d\ude00',4,false)], edges:[
    edge('Z','\u00e9','island'), edge('\u00e9','\ud83d\ude00','lazy','lazy'), edge('entry',null,'unknown'), edge('entry','entry','self') ] };
  const before = { eager: output('entry',[component('Z',['Z','\u00e9'],5),component('entry',['entry'],1),component('\ud83d\ude00',['\ud83d\ude00'],4)]), all: output('entry',[component('Z',['Z','\u00e9','\ud83d\ude00'],9),component('entry',['entry'],1)]) };
  const after = { eager: output('entry',[component('Z',['Z','\u00e9'],5),component('entry',['entry'],1),component('\ud83d\ude00',['\ud83d\ude00'],4)]), all: output('entry',[component('Z',['Z','\u00e9'],5),component('entry',['entry'],1),component('\ud83d\ude00',['\ud83d\ude00'],4)]) };
  const snapshot = JSON.stringify(baseline);
  verify(baseline, before);
  verify(remove(baseline,['unknown','self'],['entry']), before);
  verify(remove(baseline,['lazy'],['entry']), after);
  assert.equal(JSON.stringify(baseline), snapshot);
  verify(baseline, before);
});

test('missing endpoint is rejected without exposing input paths', () => {
  const report = {entry:'private-entry',modules:[moduleOf('private-entry',1,true)],edges:[edge('private-entry','private-missing','import')]};
  for (const mode of ['eager','all']) {
    const result = run(report, mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
    assert.doesNotMatch(result.stderr, /private-entry|private-missing/);
  }
});
