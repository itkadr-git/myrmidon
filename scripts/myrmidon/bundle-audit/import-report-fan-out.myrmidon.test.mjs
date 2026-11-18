import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const report = {entry:'a',modules:[{path:'a',bytes:1,eager:true},{path:'b',bytes:2,eager:true}],edges:[{from:'a',specifier:'b',kind:'eager',to:'b'}]};
test('reports direct eager dependencies', () => {
  const r = spawnSync(process.execPath, [cli], {input:JSON.stringify(report),encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, JSON.stringify({entry:'a',modules:[{path:'a',bytes:1,targets:['b'],fanOut:1},{path:'b',bytes:2,targets:[],fanOut:0}]})+'\n');
});

const m = (path, bytes, eager = false) => ({path, bytes, eager});
const e = (from, specifier, kind, to) => ({from, specifier, kind, to});
const complex = {entry:'a', modules:[m('a',1,true),m('Z',2),m('b',3),m('end',4),m('isolated',5),m('off',6)], edges:[e('a','z','eager','Z'),e('a','b','eager','b'),e('a','alias','eager','b'),e('a','missing','eager',null),e('a','lazy','lazy','end'),e('Z','end','eager','end'),e('b','end','eager','end'),e('end','self','eager','end'),e('off','isolated','eager','isolated')]};
const expected = {entry:'a',modules:[{path:'a',bytes:1,targets:['Z','b'],fanOut:2},{path:'Z',bytes:2,targets:['end'],fanOut:1},{path:'b',bytes:3,targets:['end'],fanOut:1},{path:'end',bytes:4,targets:['end'],fanOut:1},{path:'off',bytes:6,targets:['isolated'],fanOut:1},{path:'isolated',bytes:5,targets:[],fanOut:0}]};
const run = (input, args = [], cwd = homedir()) => spawnSync(process.execPath, [cli,...args], {input,encoding:'utf8',cwd});
function success(r) { assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,''); assert.equal(r.stdout,JSON.stringify(expected)+'\n'); }
function failure(r, category) { assert.equal(r.status,1); assert.equal(r.stdout,''); assert.equal(r.stderr,category+'\n'); assert.ok(!r.stderr.includes('synthetic-secret-sentinel')); }

test('diamond, aliases, self loop, disconnected nodes and permutation', () => {
  success(run(JSON.stringify(complex)));
  success(run(JSON.stringify({...complex,modules:[...complex.modules].reverse(),edges:[...complex.edges].reverse()})));
});
test('invalid argv, JSON, shape and graph have exact channels', () => {
  failure(run('{', ['synthetic-secret-sentinel']), 'argv');
  failure(run('{synthetic-secret-sentinel'), 'json');
  const shape = [null, {}, {...complex,entry:''}, {...complex,modules:[]}, {...complex,modules:[m('a',-1)]}, {...complex,modules:[m('a',Number.MAX_SAFE_INTEGER+1)]}, {...complex,modules:[{path:'a',bytes:1,eager:'synthetic-secret-sentinel'}]}, {...complex,edges:[e('a','x','wrong',null)]}, {...complex,edges:[e('a',null,'eager',null)]}, {...complex,edges:[e('a','x','eager','')]}];
  const graph = [{...complex,entry:'synthetic-secret-sentinel'}, {...complex,modules:[...complex.modules,complex.modules[0]]}, {...complex,edges:[...complex.edges,complex.edges[0]]}, {...complex,edges:[e('synthetic-secret-sentinel','x','lazy',null)]}, {...complex,edges:[e('a','x','lazy','synthetic-secret-sentinel')]}];
  for (const value of shape) failure(run(JSON.stringify(value)), 'shape');
  for (const value of graph) failure(run(JSON.stringify(value)), 'graph');
});
test('stdin may arrive in chunks including split UTF-8', async () => {
  const value = {...complex,modules:[...complex.modules,m('\u00e9',7)],edges:complex.edges};
  const bytes = Buffer.from(JSON.stringify(value));
  const child = spawn(process.execPath,[cli],{cwd:homedir()});
  let stdout='', stderr=''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  const done = new Promise((resolve,reject) => { child.on('error',reject); child.on('close',resolve); });
  for (const byte of bytes) child.stdin.write(Buffer.from([byte]));
  child.stdin.end();
  assert.equal(await done,0); assert.equal(stderr,'');
  assert.equal(stdout,JSON.stringify({...expected,modules:[...expected.modules,{path:'\u00e9',bytes:7,targets:[],fanOut:0}]})+'\n');
});
