import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-dominators.mjs');
const scanner = join(dir, 'import-budget.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: `./${to}` });
const report = (names, edges, eager = names) => ({ entry: names[0], modules: names.map(path => ({ path, bytes: 0, eager: eager.includes(path) })), edges });
function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'dominators-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function check(root, input, target, expected) {
  const path = join(root, 'report.json'), text = JSON.stringify(input);
  writeFileSync(path, text);
  const result = run(path, target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  assert.equal(readFileSync(path, 'utf8'), text);
}
test('chain and entry target', t => {
  const root = fixture(t), r = report(['a', 'b', 'c'], [edge('a','b'), edge('b','c')]);
  check(root, r, 'c', {entry:'a',target:'c',dominators:['a','b','c']});
  check(root, r, 'a', {entry:'a',target:'a',dominators:['a']});
});
test('diamond, cycles, lazy bypass, self loops and permutations', t => {
  const root = fixture(t);
  const r = report(['a','b','c','d','e'], [edge('a','b'),edge('a','c'),edge('b','d'),edge('c','d'),edge('d','b'),edge('d','d'),edge('d','e'),edge('a','e','lazy')]);
  const expected = {entry:'a',target:'e',dominators:['a','d','e']};
  check(root,r,'e',expected);
  check(root,{...r,modules:[...r.modules].reverse(),edges:[...r.edges].reverse()},'e',expected);
  check(root,r,'e',expected);
});
test('invalid input fails closed', t => {
  const root = fixture(t), path = join(root,'report.json');
  const base = report(['a','b','z'],[edge('a','b')],['a','b']);
  const cases = [null, {}, {...base,entry:''}, {...base,modules:[...base.modules,base.modules[0]]}, {...base,modules:base.modules.map((m,i)=>i===0?{...m,bytes:Number.MAX_SAFE_INTEGER+1}:m)}, {...base,modules:base.modules.map((m,i)=>i===2?{...m,eager:true}:m)}, {...base,edges:[...base.edges,base.edges[0]]}, {...base,edges:[edge('missing','b')]}, {...base,edges:[edge('a','missing')]}, {...base,edges:[{...edge('a','b'),kind:'other'}]}];
  for (const input of cases) { writeFileSync(path, JSON.stringify(input)); const r = run(path,'b'); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/^[a-z ]+\n$/); }
  writeFileSync(path,JSON.stringify(base));
  for (const args of [[path,'z'],[path,'missing'],[],[path,'b','extra'],[join(root,'missing'),'b']]) { const r=run(...args); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/^[a-z ]+\n$/); }
  writeFileSync(path,'{'); const r=run(path,'b'); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/^[a-z ]+\n$/);
});
test('validates detailed report shape, graph references and error categories', t => {
  const root = fixture(t), path = join(root, 'report.json');
  const base = report(['a', 'b'], [edge('a', 'b')]);
  const invalid = [
    [{...base, entry:'missing'}, 'graph'],
    [{...base, modules:[{path:'a', bytes:-1, eager:true}]}, 'shape'],
    [{...base, modules:[{path:'a', bytes:1.5, eager:true}]}, 'shape'],
    [{...base, modules:base.modules.map(m => ({...m, eager:'true'}))}, 'shape'],
    [{...base, modules:[{path:'', bytes:0, eager:true}]}, 'shape'],
    [{...base, edges:[{...edge('a','b'), specifier:''}]}, 'shape'],
    [{...base, edges:[{...edge('a','b'), to:42}]}, 'shape'],
    [{...base, modules:[{path:'a', bytes:Number.MAX_SAFE_INTEGER, eager:true}, {path:'b', bytes:1, eager:true}]}, 'shape'],
    [{...base, modules:base.modules.map(m => ({...m, eager:false}))}, 'graph'],
  ];
  for (const [input, category] of invalid) {
    writeFileSync(path, JSON.stringify(input));
    const result = run(path, 'b');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${category}\n`);
  }
  writeFileSync(path, JSON.stringify({...base, edges:[...base.edges, {...edge('a', null), specifier:'external'}]}));
  const result = run(path, 'b');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, JSON.stringify({entry:'a',target:'b',dominators:['a','b']}) + '\n');
});
test('integrates with actual import-budget scanner without executing input', t => {
  const root=fixture(t), entry=join(root,'entry.mjs');
  writeFileSync(entry,"import './middle.mjs';\nthrow new Error('must not execute');\n");
  writeFileSync(join(root,'middle.mjs'),"import './end.mjs';\n");
  writeFileSync(join(root,'end.mjs'),'');
  const scanned=spawnSync(process.execPath,[scanner,entry],{encoding:'utf8',timeout:10000});
  assert.equal(scanned.status,0,scanned.stderr);
  const path=join(root,'report.json'); writeFileSync(path,scanned.stdout);
  const result=run(path,'end.mjs'); assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,JSON.stringify({entry:'entry.mjs',target:'end.mjs',dominators:['end.mjs','entry.mjs','middle.mjs']})+'\n');
});
