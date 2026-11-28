import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = join(dir, 'import-report-subgraph.mjs');
const scanner = join(dir, 'import-budget.mjs');
const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
const m = (path, bytes, eager) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const report = { entry: 'a', modules: [m('a',1,true),m('b',2,true),m('c',3,false),m('d',4,false)], edges: [e('a','b','eager','b'),e('a','c','lazy','c'),e('b','a','eager','a'),e('b','alias','eager','a'),e('b','unknown','eager',null),e('c','d','eager','d')] };
function fixture(t, value = report) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(base, 'subgraph-')); t.after(() => rmSync(tmp, { recursive:true, force:true }));
  const file = join(tmp, 'report.json'); writeFileSync(file, JSON.stringify(value)); return {tmp,file};
}
function success(r, expected) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.equal(r.stdout, JSON.stringify(expected) + '\n'); }
test('mode boundary, cycles, aliases, unknown, permutation and repeat', t => {
  const {file} = fixture(t); const before = readFileSync(file, 'utf8');
  const eager = {root:'a',mode:'eager',modules:[m('a',1,true),m('b',2,true)],edges:[e('a','b','eager','b'),e('b','a','eager','a'),e('b','alias','eager','a'),e('b','unknown','eager',null)],unknown:[e('b','unknown','eager',null)]};
  const all = {root:'a',mode:'all',modules:[m('a',1,true),m('b',2,true),m('c',3,false),m('d',4,false)],edges:[e('a','b','eager','b'),e('a','c','lazy','c'),e('b','a','eager','a'),e('b','alias','eager','a'),e('b','unknown','eager',null),e('c','d','eager','d')],unknown:[e('b','unknown','eager',null)]};
  success(run(cli,file,'a','eager'), eager); success(run(cli,file,'a','all'), all); success(run(cli,file,'a','eager'), eager);
  assert.equal(readFileSync(file,'utf8'),before);
  writeFileSync(file, JSON.stringify({...report,modules:[...report.modules].reverse(),edges:[...report.edges].reverse()})); success(run(cli,file,'a','all'),all);
});
test('disconnected root and isolated leaf retain original flags', t => {
  const {file} = fixture(t); success(run(cli,file,'c','eager'),{root:'c',mode:'eager',modules:[m('c',3,false),m('d',4,false)],edges:[e('c','d','eager','d')],unknown:[]});
  success(run(cli,file,'d','all'),{root:'d',mode:'all',modules:[m('d',4,false)],edges:[],unknown:[]});
});
test('disconnected diamond keeps extra fields and uses code-unit ordering', t => {
  const value = {
    entry: 'entry',
    modules: [m('entry', 1, true), {...m('root', 2, false), tag: 'preserved'}, m('Z', 3, false), m('a', 4, false), m('end', 5, false)],
    edges: [e('root', 'z', 'eager', 'a'), e('a', 'end', 'eager', 'end'), e('root', 'A', 'eager', 'Z'), e('Z', 'end', 'eager', 'end'), e('root', 'unknown', 'eager', null)],
  };
  const {file} = fixture(t, value);
  success(run(cli, file, 'root', 'eager'), {
    root: 'root', mode: 'eager',
    modules: [m('Z', 3, false), m('a', 4, false), m('end', 5, false), {...m('root', 2, false), tag: 'preserved'}],
    edges: [e('Z', 'end', 'eager', 'end'), e('a', 'end', 'eager', 'end'), e('root', 'A', 'eager', 'Z'), e('root', 'unknown', 'eager', null), e('root', 'z', 'eager', 'a')],
    unknown: [e('root', 'unknown', 'eager', null)],
  });
});
test('invalid input fails without leaking values', t => {
  const cases = [null, {}, {...report,entry:'missing'}, {...report,modules:[...report.modules,report.modules[0]]}, {...report,modules:[m('a',-1,true)]}, {...report,modules:report.modules.map(x=>({...x,eager:true}))}, {...report,edges:[...report.edges,report.edges[0]]}, {...report,edges:[e('a','x','eager','missing')]}, {...report,edges:[e('missing','x','eager','a')]}, {...report,edges:[e('a','x','other',null)]}];
  const {file} = fixture(t);
  for (const value of cases) { writeFileSync(file,JSON.stringify(value)); const r=run(cli,file,'a','all'); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/^(shape|graph) error\n$/); }
  writeFileSync(file,'{bad'); for (const args of [[file,'a','all'],[file,'a','bad'],[join(dirname(file),'missing'),'a','all'],[]]) { const r=run(cli,...args); assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/^(argv|read|json) error\n$/); }
});
test('accepts a real scanner report without executing input', t => {
  const {tmp,file}=fixture(t); const entry=join(tmp,'entry.js'); writeFileSync(entry,"import './dep.js'; import('./lazy.js'); throw new Error('must not execute');\n"); writeFileSync(join(tmp,'dep.js'),'export {};\n'); writeFileSync(join(tmp,'lazy.js'),'export {};\n');
  const scanned=run(scanner,entry); assert.equal(scanned.status,0,scanned.stderr); writeFileSync(file,scanned.stdout);
  success(run(cli,file,'entry.js','eager'),{root:'entry.js',mode:'eager',modules:[m('dep.js',11,true),m('entry.js',77,true)],edges:[e('entry.js','./dep.js','eager','dep.js')],unknown:[]});
});
