import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-condensation.mjs', import.meta.url).pathname;
const run = (input, args = ['eager']) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 5000 });
const m = (path, bytes = 1) => ({ path, bytes, eager: true });
const e = (from, to, kind = 'eager', specifier = to ?? 'external') => ({ from, to, kind, specifier });
const component = (id, paths, bytes = paths.length) => ({ id, paths, bytes });
function check(report, mode, components, edges) {
  const result = run(JSON.stringify(report), [mode]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, { entry: report.entry, components, edges });
  const paths = output.components.flatMap(c => c.paths);
  assert.deepEqual(paths.slice().sort(), report.modules.map(x => x.path).sort());
  assert.equal(new Set(paths).size, paths.length);
  const degree = new Map(components.map(c => [c.id, 0]));
  for (const edge of output.edges) degree.set(edge.to, degree.get(edge.to) + 1);
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id);
  let count = 0;
  while (queue.length) {
    const id = queue.pop(); count++;
    for (const edge of output.edges.filter(x => x.from === id)) {
      degree.set(edge.to, degree.get(edge.to) - 1);
      if (degree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  assert.equal(count, components.length, 'condensation must be acyclic');
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  assert.equal(run(JSON.stringify(reversed), [mode]).stdout, result.stdout);
}

test('isolated, chain, diamond, self loop and null target', () => {
  check({ entry: 'a', modules: [m('a', 0)], edges: [e('a', 'a'), e('a', null)] }, 'eager', [component('a', ['a'], 0)], []);
  const report = { entry: 'a', modules: ['a','b','c','d'].map(x => m(x)), edges: [e('a','b'),e('a','c'),e('b','d'),e('c','d')] };
  check(report, 'eager', ['a','b','c','d'].map(x => component(x,[x])), [{from:'a',to:'b'},{from:'a',to:'c'},{from:'b',to:'d'},{from:'c',to:'d'}]);
  check({ entry: 'a', modules: [m('a'),m('b'),m('c')], edges: [e('a','b'),e('b','c')] }, 'eager', ['a','b','c'].map(x => component(x,[x])), [{from:'a',to:'b'},{from:'b',to:'c'}]);
});

test('two SCCs collapse parallel edges and include disconnected cycles', () => {
  const report = { entry: 'a', modules: ['a','b','c','d','x','y'].map(x => m(x)), edges: [e('a','b'),e('b','a'),e('c','d'),e('d','c'),e('a','c'),e('b','d'),e('x','y'),e('y','x')] };
  check(report, 'eager', [component('a',['a','b']),component('c',['c','d']),component('x',['x','y'])], [{from:'a',to:'c'}]);
});

test('lazy edge closes SCC only in all mode', () => {
  const report = { entry: 'a', modules: [m('a',2),m('b',3)], edges: [e('a','b'),e('b','a','lazy')] };
  check(report, 'eager', [component('a',['a'],2),component('b',['b'],3)], [{from:'a',to:'b'}]);
  check(report, 'all', [component('a',['a','b'],5)], []);
});

test('invalid inputs use safe error channels', () => {
  const valid = { entry: 'secret', modules: [m('secret'),m('b')], edges: [] };
  const cases = [
    ['argv', JSON.stringify(valid), []], ['argv', JSON.stringify(valid), ['secret']], ['argv', JSON.stringify(valid), ['all','extra']],
    ['json','{secret',['eager']], ['shape','{}',['eager']],
    ['shape',JSON.stringify({...valid,modules:[m('secret',-1)]}),['eager']],
    ['graph',JSON.stringify({...valid,entry:'missing'}),['eager']],
    ['graph',JSON.stringify({...valid,modules:[m('secret'),m('secret')]}),['eager']],
    ['graph',JSON.stringify({...valid,edges:[e('secret','b'),e('secret','b')]}),['eager']],
    ['graph',JSON.stringify({...valid,edges:[e('secret','missing')]}),['eager']],
    ['graph',JSON.stringify({entry:'a',modules:[m('a',Number.MAX_SAFE_INTEGER),m('b',1)],edges:[e('a','b'),e('b','a')]}),['eager']],
  ];
  for (const [category,input,args] of cases) {
    const result = run(input,args);
    assert.equal(result.status,1,category); assert.equal(result.stdout,''); assert.equal(result.stderr,`${category}\n`);
  }
});
