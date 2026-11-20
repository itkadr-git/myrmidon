import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const m = (path, bytes, eager = false) => ({ path, bytes, eager });
const e = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const report = { entry: 'a', modules: [m('a', 1, true), m('b', 2), m('c', 3), m('d', 4), m('e', 5), m('Z', 6)], edges: [e('b','a','eager','a'), e('c','b','eager','b'), e('c','alias','eager','b'), e('c','self','eager','c'), e('d','e','eager','e'), e('c','bridge','lazy','d'), e('a','unknown','eager',null)] };
const run = (input, args = ['eager'], cwd = homedir()) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', cwd, timeout: 10000 });
function success(r, value) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, ''); assert.equal(r.stdout, JSON.stringify(value) + '\n'); }
function failure(r, category) { assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr, category + '\n'); }

test('weak connectivity includes reverse chains, bridges, aliases and isolated modules', () => {
  const eager = { entry:'a', components:[{id:'Z',paths:['Z'],bytes:6},{id:'a',paths:['a','b','c'],bytes:6},{id:'d',paths:['d','e'],bytes:9}] };
  const all = { entry:'a', components:[{id:'Z',paths:['Z'],bytes:6},{id:'a',paths:['a','b','c','d','e'],bytes:15}] };
  success(run(JSON.stringify(report)), eager);
  success(run(JSON.stringify(report), ['all']), all);
  const permuted = {...report, modules:[...report.modules].reverse(), edges:[...report.edges].reverse()};
  success(run(JSON.stringify(permuted), ['all']), all);
  for (const result of [eager, all]) {
    assert.deepEqual(result.components.flatMap(c => c.paths).sort(), report.modules.map(x => x.path).sort());
    assert.equal(result.components.reduce((n,c) => n + c.bytes,0), 21);
  }
});

test('safe byte limit and overflow', () => {
  const value = {entry:'a',modules:[m('a',Number.MAX_SAFE_INTEGER),m('b',0)],edges:[e('a','','eager','b')]};
  success(run(JSON.stringify(value)), {entry:'a',components:[{id:'a',paths:['a','b'],bytes:Number.MAX_SAFE_INTEGER}]});
  failure(run(JSON.stringify({...value,modules:[m('a',Number.MAX_SAFE_INTEGER),m('b',1)]})), 'graph');
});

test('rejects invalid byte values and edge field types', () => {
  for (const bytes of [Number.MAX_SAFE_INTEGER + 1, 1.5, '1', null]) {
    failure(run(JSON.stringify({entry:'a', modules:[m('a', bytes)], edges:[]})), 'shape');
  }
  for (const edge of [e(1,'x','eager','a'), e('a',1,'eager','a'), e('a','x','eager',1)]) {
    failure(run(JSON.stringify({entry:'a', modules:[m('a', 0)], edges:[edge]})), 'shape');
  }
});

test('error categories and channels do not disclose input', () => {
  const secret = 'synthetic-secret-sentinel';
  failure(run('{'+secret), 'json');
  for (const args of [[], ['other'], ['all','extra']]) failure(run(JSON.stringify(report), args), 'argv');
  for (const value of [null, {}, {...report,entry:''}, {...report,modules:[]}, {...report,modules:[m('a',-1)]}, {...report,modules:[{path:'a',bytes:0,eager:1}]}, {...report,edges:[e('a','x','invalid',null)]}, {...report,edges:[e('a','x','eager','')]}]) failure(run(JSON.stringify(value)), 'shape');
  for (const value of [{...report,entry:secret}, {...report,modules:[...report.modules,report.modules[0]]}, {...report,edges:[...report.edges,report.edges[0]]}, {...report,edges:[e(secret,'x','eager','a')]}, {...report,edges:[e('a','x','eager',secret)]}]) failure(run(JSON.stringify(value)), 'graph');
});

test('reads stdin across chunk boundaries', async () => {
  const input = JSON.stringify(report);
  const child = spawn(process.execPath, [cli,'all'], {cwd:homedir(), stdio:['pipe','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  const done = new Promise((resolve, reject) => { child.on('error',reject); child.on('close',resolve); });
  child.stdin.write(input.slice(0, 17)); child.stdin.write(input.slice(17, 52)); child.stdin.end(input.slice(52));
  const status = await done;
  success({status,stdout,stderr}, {entry:'a',components:[{id:'Z',paths:['Z'],bytes:6},{id:'a',paths:['a','b','c','d','e'],bytes:15}]});
});
