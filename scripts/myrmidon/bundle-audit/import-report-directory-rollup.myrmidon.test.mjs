import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const scanner = fileURLToPath(new URL('./import-budget.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
const scratch = t => { const d = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'rollup-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const fixture = () => ({ entry: 'entry.js', modules: [
  {path:'entry.js', bytes:2, eager:true}, {path:'a/same.js', bytes:3, eager:true},
  {path:'a/lazy.js', bytes:7, eager:false}, {path:'a/nested/same.js', bytes:0, eager:false},
  {path:'with space/x.js', bytes:5, eager:false}, {path:'\u00e9/x.js', bytes:4, eager:false}
], edges: [{from:'entry.js',specifier:'a',kind:'eager',to:'a/same.js'}, {from:'entry.js',specifier:'lazy',kind:'lazy',to:'a/lazy.js'}] });
const expected = {entry:'entry.js',directories:[
  {directory:'.',modules:1,eagerModules:1,totalBytes:2,eagerBytes:2},
  {directory:'a',modules:2,eagerModules:1,totalBytes:10,eagerBytes:3},
  {directory:'a/nested',modules:1,eagerModules:0,totalBytes:0,eagerBytes:0},
  {directory:'with space',modules:1,eagerModules:0,totalBytes:5,eagerBytes:0},
  {directory:'\u00e9',modules:1,eagerModules:0,totalBytes:4,eagerBytes:0}
]};

test('rolls up immediate directories deterministically without changing input', t => {
  const dir = scratch(t), file = join(dir,'report.json'), report = fixture();
  for (const data of [report, {...report, modules:[...report.modules].reverse(), edges:[...report.edges].reverse()}]) {
    const input = JSON.stringify(data); writeFileSync(file,input);
    const result = run(file); assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
    assert.equal(result.stdout, JSON.stringify(expected)+'\n'); assert.equal(readFileSync(file,'utf8'),input);
  }
});

test('rejects invalid arguments, files, JSON, shape and graph without output leaks', t => {
  const dir = scratch(t), file = join(dir, 'input.json');
  const check = (result, category) => { assert.equal(result.status,1); assert.equal(result.stdout,''); assert.equal(result.stderr,category+'\n'); };
  check(run(),'argv'); check(run(file,'extra'),'argv'); check(run(file),'file');
  writeFileSync(file,'SECRET{'); check(run(file),'json');
  const invalidShapes = [null, {}, {...fixture(), modules:[]}, ...['/abs','a//b','a/./b','a/../b','a\\b',''].map(path => ({...fixture(),modules:[{path,bytes:1,eager:true}]})), {...fixture(),modules:[{path:'entry.js',bytes:-1,eager:true}]}, {...fixture(),edges:[{from:'entry.js',specifier:1,kind:'eager',to:null}]}];
  const base = fixture();
  const invalidGraphs = [ {...base,entry:'missing'}, {...base,modules:[...base.modules,base.modules[0]]}, {...base,edges:[...base.edges,base.edges[0]]}, {...base,edges:[{from:'missing',specifier:'',kind:'eager',to:null}]}, {...base,edges:[{from:'entry.js',specifier:'',kind:'eager',to:'missing'}]}, {...base,modules:base.modules.map((m,i) => i === 1 ? {...m,eager:false} : m)} ];
  for (const [category, cases] of [['shape',invalidShapes],['graph',invalidGraphs]]) for (const value of cases) { writeFileSync(file,JSON.stringify(value)); check(run(file),category); }
});

test('accepts safe maximum and fails closed on overflow', t => {
  const dir = scratch(t), file = join(dir,'report.json');
  const report = {entry:'entry.js',modules:[{path:'entry.js',bytes:Number.MAX_SAFE_INTEGER,eager:true},{path:'other.js',bytes:0,eager:false}],edges:[]};
  writeFileSync(file,JSON.stringify(report)); const ok = run(file);
  assert.equal(ok.status,0,ok.stderr); assert.equal(ok.stdout,JSON.stringify({entry:'entry.js',directories:[{directory:'.',modules:2,eagerModules:1,totalBytes:9007199254740991,eagerBytes:9007199254740991}]})+'\n');
  report.modules[1].bytes = 1; writeFileSync(file,JSON.stringify(report)); const bad = run(file);
  assert.equal(bad.status,1); assert.equal(bad.stdout,''); assert.equal(bad.stderr,'graph\n');
});

test('accepts a real scanner report and never executes source', t => {
  const dir = scratch(t), source = "import './sub/eager.mjs';\nimport('./sub/lazy.mjs');\nthrow new Error('must not execute');\n", eager = 'export const a = 1;\n', lazy = 'export const b = 2;\n';
  mkdirSync(join(dir,'sub')); writeFileSync(join(dir,'entry.mjs'),source); writeFileSync(join(dir,'sub/eager.mjs'),eager); writeFileSync(join(dir,'sub/lazy.mjs'),lazy);
  const scan = spawnSync(process.execPath,[scanner,join(dir,'entry.mjs')],{encoding:'utf8',timeout:10000}); assert.equal(scan.status,0,scan.stderr);
  const file = join(dir,'scan.json'); writeFileSync(file,scan.stdout); const result = run(file);
  assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
  assert.equal(result.stdout, JSON.stringify({entry:'entry.mjs',directories:[{directory:'.',modules:1,eagerModules:1,totalBytes:Buffer.byteLength(source),eagerBytes:Buffer.byteLength(source)},{directory:'sub',modules:2,eagerModules:1,totalBytes:Buffer.byteLength(eager)+Buffer.byteLength(lazy),eagerBytes:Buffer.byteLength(eager)}]})+'\n');
  assert.equal(readFileSync(file,'utf8'),scan.stdout); assert.equal(readFileSync(join(dir,'entry.mjs'),'utf8'),source);
});
