import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to, kind = 'eager', specifier = String(to)) => ({ from, specifier, kind, to });
const run = (input, args = [], cwd = homedir()) => spawnSync(process.execPath, [cli, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', cwd, timeout: 10000 });
function success(result, expected) { assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); assert.equal(result.stdout, JSON.stringify(expected) + '\n'); }
function failure(result, category) { assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, category + '\n'); }

test('chain includes entry and reachable weights', () => {
  success(run({entry:'a', modules:[m('a',2),m('b',3),m('c',4)], edges:[e('a','b'),e('b','c')]}), {entry:'a',paths:['a','b','c'],bytes:9});
});
test('weighted diamond, ties, prefix and eager boundary', () => {
  const report = {entry:'a', modules:[m('a',0),m('b',1),m('c',8),m('d',1),m('z',0),m('x',99,false)], edges:[e('a','b'),e('b','d'),e('a','c'),e('a','x','lazy'),e('x','x'),e('a',null)]};
  success(run(report), {entry:'a',paths:['a','c'],bytes:8});
  const tie = {entry:'a',modules:[m('a',0),m('Z',2),m('b',2),m('z',0)],edges:[e('a','b'),e('a','Z'),e('Z','z')]};
  const expected = {entry:'a',paths:['a','Z'],bytes:2};
  success(run(tie),expected); success(run({...tie,edges:[...tie.edges].reverse()}),expected);
  success(run({entry:'a',modules:[m('a',0),m('b',0)],edges:[e('a','b')]}),{entry:'a',paths:['a'],bytes:0});
});
test('cycles and overflow only affect reachable eager paths', () => {
  const base = {entry:'a',modules:[m('a',1),m('b',2),m('x',1,false)],edges:[e('a','b'),e('x','x')]};
  success(run(base),{entry:'a',paths:['a','b'],bytes:3});
  failure(run({...base,edges:[...base.edges,e('b','a')]}),'graph');
  failure(run({...base,edges:[...base.edges,e('a','a')]}),'graph');
  failure(run({entry:'a',modules:[m('a',Number.MAX_SAFE_INTEGER),m('b',1)],edges:[e('a','b')]}),'graph');
});
test('invalid input and arguments have exact sanitized channels', () => {
  const secret = 'SYNTHETIC_SECRET_SENTINEL';
  const good = {entry:'a',modules:[m('a',1)],edges:[]};
  failure(run(good,[secret]),'argv'); failure(run('{'+secret),'json');
  for (const value of [null,{}, {...good,modules:[m('a',-1)]}, {...good,modules:[{path:'a',bytes:1,eager:secret}]}, {...good,edges:[e('a','a','bad',secret)]}]) failure(run(value),'shape');
  for (const value of [{...good,entry:secret}, {...good,modules:[m('a',1),m('a',2)]}, {...good,edges:[e('a',secret)]}, {...good,edges:[e(secret,'a')]}, {...good,edges:[e('a','a'),e('a','a')]}]) failure(run(value),'graph');
});
test('stdin accepts chunks across UTF-8 boundaries', async () => {
  const input = Buffer.from(JSON.stringify({entry:'é',modules:[m('é',3)],edges:[]}));
  const child = spawn(process.execPath,[cli],{cwd:homedir(),stdio:['pipe','pipe','pipe']});
  let stdout='', stderr=''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',x=>stdout+=x); child.stderr.on('data',x=>stderr+=x);
  for (const byte of input) child.stdin.write(Buffer.from([byte])); child.stdin.end();
  const status = await new Promise((resolve,reject)=>{child.on('error',reject); child.on('close',resolve);});
  success({status,stdout,stderr},{entry:'é',paths:['é'],bytes:3});
});
