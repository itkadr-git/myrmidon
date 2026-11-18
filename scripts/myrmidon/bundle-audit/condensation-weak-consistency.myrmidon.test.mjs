import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
const weak = process.env.MYRMIDON_WEAK_CLI || cli('import-report-weak-components.mjs');
const condensation = cli('import-report-condensation.mjs');
const scanner = cli('import-budget.mjs');
const component = (id, paths, bytes) => ({ id, paths, bytes });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });

function run(program, args, input) {
  const result = spawnSync(process.execPath, [program, ...args], { input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return { raw: result.stdout, json: JSON.parse(result.stdout) };
}

function check(input, mode, expectedWeak, expectedCondensation) {
  const w = run(weak, [mode], input).json;
  const c = run(condensation, [mode], input).json;
  assert.deepEqual(w, expectedWeak);
  assert.deepEqual(c, expectedCondensation);
  for (const scc of c.components) {
    assert.equal(w.components.filter(group => scc.paths.every(path => group.paths.includes(path))).length, 1);
  }
}

test('independent partitions cover reverse chain, bridged SCCs, lazy closure and isolated vertex', () => {
  const report = {
    entry: 'a',
    modules: ['a','b','c','d','e','z'].map((path, i) => ({ path, bytes: i + 1, eager: true })),
    edges: [edge('b','a'), edge('c','b'), edge('c','d'), edge('d','c'), edge('d','e'), edge('e','d'), edge('a','c','lazy')],
  };
  const input = JSON.stringify(report);
  const weakExpected = { entry:'a', components:[component('a',['a','b','c','d','e'],15),component('z',['z'],6)] };
  check(input, 'eager', weakExpected, { entry:'a', components:[component('a',['a'],1),component('b',['b'],2),component('c',['c','d','e'],12),component('z',['z'],6)], edges:[{from:'b',to:'a'},{from:'c',to:'b'}] });
  check(input, 'all', weakExpected, { entry:'a', components:[component('a',['a','b','c','d','e'],15),component('z',['z'],6)], edges:[] });
});

test('a one-way bridge joins two SCCs into one weak component', () => {
  const report = { entry:'a', modules:['a','b','c','d'].map((path, i) => ({path, bytes:i + 1, eager:true})), edges:[edge('a','b'),edge('b','a'),edge('b','c'),edge('c','d'),edge('d','c')] };
  const w = {entry:'a',components:[component('a',['a','b','c','d'],10)]};
  const c = {entry:'a',components:[component('a',['a','b'],3),component('c',['c','d'],7)],edges:[{from:'a',to:'c'}]};
  for (const mode of ['eager','all']) check(JSON.stringify(report), mode, w, c);
});

test('scanner output feeds both consumers without executing sources', () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-consistency-'));
  try {
    const sentinel = join(dir, 'executed');
    const sources = {
      'entry.mjs': `import './a.mjs';\nimport('./b.mjs');\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'executed');\nthrow new Error('must not execute');\n`,
      'a.mjs': "import './b.mjs';\nthrow new Error('must not execute');\n",
      'b.mjs': "import './entry.mjs';\nthrow new Error('must not execute');\n",
    };
    for (const [name, content] of Object.entries(sources)) writeFileSync(join(dir, name), content);
    const scanned = run(scanner, [join(dir, 'entry.mjs')]);
    assert.equal(existsSync(sentinel), false);
    const bytes = name => Buffer.byteLength(sources[name]);
    const sum = bytes('entry.mjs') + bytes('a.mjs') + bytes('b.mjs');
    const weakExpected = {entry:'entry.mjs',components:[component('a.mjs',['a.mjs','b.mjs','entry.mjs'],sum)]};
    const expected = {entry:'entry.mjs',components:[component('a.mjs',['a.mjs','b.mjs','entry.mjs'],sum)],edges:[]};
    check(scanned.raw, 'eager', weakExpected, expected);
    check(scanned.raw, 'all', weakExpected, expected);
    assert.equal(existsSync(sentinel), false);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
