import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const m = (path, bytes, eager = true) => ({path, bytes, eager});
const e = (from, specifier, kind, to) => ({from, specifier, kind, to});
const report = {entry:'entry', modules:[m('entry',1),m('b',2),m('Z',3),m('end',4),m('off',8,false)], edges:[e('entry','b','eager','b'),e('b','Z','eager','Z'),e('Z','end','eager','end'),e('end','b','eager','b'),e('entry','shortcut','lazy','end'),e('b','alias','eager','Z'),e('b','unknown','eager',null)]};
const run = (args, input = JSON.stringify(report), cwd = homedir()) => spawnSync(process.execPath, [cli,...args], {input, encoding:'utf8', cwd, timeout:10000});
function ok(r, removed, lostPaths, lostBytes) { assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,''); assert.equal(r.stdout,JSON.stringify({entry:'entry',removed,lostPaths,lostBytes})+'\n'); }
function bad(r, category) { assert.equal(r.status,1); assert.equal(r.stdout,''); assert.equal(r.stderr,category+'\n'); }

test('chain, cycle, entry and disconnected removal; lazy shortcut and aliases', () => {
  ok(run(['b']),'b',['Z','b','end'],9);
  ok(run(['entry']),'entry',['Z','b','end','entry'],10);
  ok(run(['off']),'off',[],0);
});
test('diamond retains nodes reachable by an alternative eager path', () => {
  const diamond = {...report,edges:[...report.edges,e('entry','alternative','eager','Z')]};
  ok(run(['b'],JSON.stringify(diamond)),'b',['b'],2);
});
test('empty modules is a shape error', () => {
  bad(run(['entry'], JSON.stringify({entry:'entry', modules:[], edges:[]})), 'shape');
});
test('errors have exact channels and never leak input', () => {
  const secret = 'synthetic-secret-sentinel';
  bad(run([]),'argv'); bad(run(['b','extra']),'argv'); bad(run(['missing']),'argv');
  bad(run(['b'],'{'+secret),'json');
  for (const value of [null,{}, {...report,modules:[m('entry',-1)]}, {...report,edges:[e('entry',secret,'bad',null)]}]) bad(run(['b'],JSON.stringify(value)),'shape');
  for (const value of [{...report,entry:secret}, {...report,modules:[...report.modules,report.modules[0]]}, {...report,edges:[...report.edges,report.edges[0]]}, {...report,edges:[e('entry',secret,'eager',secret)]}, {...report,modules:report.modules.map(x=>({...x,bytes:Number.MAX_SAFE_INTEGER}))}]) bad(run(['b'],JSON.stringify(value)),'graph');
});
test('reads UTF-8 stdin across chunks from an unrelated cwd', async () => {
  const input = JSON.stringify(report);
  const child = spawn(process.execPath,[cli,'b'],{cwd:homedir(),stdio:['pipe','pipe','pipe']});
  let stdout='', stderr=''; child.stdout.setEncoding('utf8').on('data',x=>stdout+=x); child.stderr.setEncoding('utf8').on('data',x=>stderr+=x);
  const done = new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});
  child.stdin.write(input.slice(0,11)); child.stdin.end(input.slice(11));
  ok(await done,'b',['Z','b','end'],9);
});
