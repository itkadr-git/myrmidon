import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const m = (path, bytes) => ({ path, bytes, eager: true });
const e = (from, to, kind = 'eager', specifier = to) => ({ from, to, kind, specifier });
const c = (id, paths, bytes) => ({ id, paths, bytes });
const d = (from, to) => ({ from, to });
const run = (report, mode) => spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(report), encoding: 'utf8', timeout: 5000 });

// All outputs below are independent, hand-written expectations, not derived from CLI output.
const cases = [
  {
    a: { entry: 'a', modules: [m('a', 2), m('b', 3), m('c', 7)], edges: [e('a','b'), e('b','a'), e('a','c','eager','one'), e('b','c','eager','two')] },
    b: { entry: 'x', modules: [m('x', 11), m('y', 13)], edges: [e('x','y'), e('y','x')] },
    eager: [
      { entry:'a', components:[c('a',['a','b'],5),c('c',['c'],7)], edges:[d('a','c')] },
      { entry:'x', components:[c('x',['x','y'],24)], edges:[] },
      { entry:'a', components:[c('a',['a','b'],5),c('c',['c'],7),c('x',['x','y'],24)], edges:[d('a','c')] },
    ],
    all: [
      { entry:'a', components:[c('a',['a','b'],5),c('c',['c'],7)], edges:[d('a','c')] },
      { entry:'x', components:[c('x',['x','y'],24)], edges:[] },
      { entry:'a', components:[c('a',['a','b'],5),c('c',['c'],7),c('x',['x','y'],24)], edges:[d('a','c')] },
    ],
  },
  {
    a: { entry:'d', modules:[m('d',4),m('e',6)], edges:[e('d','e'),e('e','d','lazy')] },
    b: { entry:'p', modules:[m('p',8),m('q',9),m('r',10)], edges:[e('p','q'),e('p','q','eager','alternate'),e('q','r')] },
    eager: [
      { entry:'d', components:[c('d',['d'],4),c('e',['e'],6)], edges:[d('d','e')] },
      { entry:'p', components:[c('p',['p'],8),c('q',['q'],9),c('r',['r'],10)], edges:[d('p','q'),d('q','r')] },
      { entry:'d', components:[c('d',['d'],4),c('e',['e'],6),c('p',['p'],8),c('q',['q'],9),c('r',['r'],10)], edges:[d('d','e'),d('p','q'),d('q','r')] },
    ],
    all: [
      { entry:'d', components:[c('d',['d','e'],10)], edges:[] },
      { entry:'p', components:[c('p',['p'],8),c('q',['q'],9),c('r',['r'],10)], edges:[d('p','q'),d('q','r')] },
      { entry:'d', components:[c('d',['d','e'],10),c('p',['p'],8),c('q',['q'],9),c('r',['r'],10)], edges:[d('p','q'),d('q','r')] },
    ],
  },
  {
    a: { entry:'m', modules:[m('m',0)], edges:[e('m','m')] },
    b: { entry:'h', modules:[m('h',3),m('i',5),m('j',7)], edges:[e('h','i','lazy'),e('i','j'),e('j','i')] },
    eager: [
      { entry:'m', components:[c('m',['m'],0)], edges:[] },
      { entry:'h', components:[c('h',['h'],3),c('i',['i','j'],12)], edges:[] },
      { entry:'m', components:[c('h',['h'],3),c('i',['i','j'],12),c('m',['m'],0)], edges:[] },
    ],
    all: [
      { entry:'m', components:[c('m',['m'],0)], edges:[] },
      { entry:'h', components:[c('h',['h'],3),c('i',['i','j'],12)], edges:[d('h','i')] },
      { entry:'m', components:[c('h',['h'],3),c('i',['i','j'],12),c('m',['m'],0)], edges:[d('h','i')] },
    ],
  },
];

test('disjoint graph unions retain each hand-specified condensation in eager and all modes', () => {
  for (const fixture of cases) {
    const before = JSON.stringify(fixture);
    const { a, b } = fixture;
    const union = { entry:a.entry, modules:[...a.modules,...b.modules], edges:[...a.edges,...b.edges] };
    for (const mode of ['eager', 'all']) {
      for (const [index, report] of [a, b, union].entries()) {
        const expected = `${JSON.stringify(fixture[mode][index])}\n`;
        const reversed = { ...report, modules:[...report.modules].reverse(), edges:[...report.edges].reverse() };
        for (const input of [report, reversed, report]) {
          const result = run(input, mode);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(result.stdout, expected);
        }
      }
    }
    assert.equal(JSON.stringify(fixture), before);
  }
});

test('missing endpoint is rejected without disclosing input', () => {
  const report = { entry:'private-entry', modules:[m('private-entry',1)], edges:[e('private-entry','private-missing')] };
  for (const mode of ['eager', 'all']) {
    const result = run(report, mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
