import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-directory-rollup.mjs', import.meta.url));
const report = { entry:'entry.js', modules:[
  {path:'entry.js',bytes:2,eager:true}, {path:'lib/eager.js',bytes:3,eager:true},
  {path:'lib/lazy.js',bytes:7,eager:false}
], edges:[
  {from:'entry.js',specifier:'eager',kind:'eager',to:'lib/eager.js'},
  {from:'entry.js',specifier:'lazy',kind:'lazy',to:'lib/lazy.js'}
] };
const expected = JSON.stringify({entry:'entry.js',directories:[
  {directory:'.',modules:1,eagerModules:1,totalBytes:2,eagerBytes:2},
  {directory:'lib',modules:2,eagerModules:1,totalBytes:10,eagerBytes:3}
]}) + '\n';

function setup(t) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'rollup-stdin-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const cwd1 = join(dir,'one'), cwd2 = join(dir,'two');
  mkdirSync(cwd1); mkdirSync(cwd2);
  return {dir,cwd1,cwd2};
}
function run(cwd, args, input) {
  const result = spawnSync(process.execPath, [cli,...args], {
    cwd, input, encoding:'utf8', timeout:10000, env:{...process.env,TMPDIR:cwd}
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
function check(result, status, stdout, stderr) {
  assert.equal(result.status,status);
  assert.equal(result.stdout,stdout);
  assert.equal(result.stderr,stderr);
}

test('stdin matches file output across working directories and repeated invocations', t => {
  const {cwd1,cwd2} = setup(t), input = JSON.stringify(report) + ' \n\t';
  writeFileSync(join(cwd1,'report.json'),input);
  writeFileSync(join(cwd2,'-'),input);
  check(run(cwd1,['report.json'],''),0,expected,'');
  check(run(cwd2,['./-'],'not JSON sentinel'),0,expected,'');
  for (const cwd of [cwd1,cwd2]) for (let i = 0; i < 2; i++) {
    check(run(cwd,['-'],input),0,expected,'');
  }
  assert.equal(readFileSync(join(cwd1,'report.json'),'utf8'),input);
  assert.equal(readFileSync(join(cwd2,'-'),'utf8'),input);
});

test('stdin failures are atomic and argument validation takes precedence', t => {
  const {cwd1} = setup(t);
  for (const input of ['', ' \n\t', '{"sentinel":', '{} {}']) {
    check(run(cwd1,['-'],input),1,'','json\n');
  }
  check(run(cwd1,['-'],JSON.stringify({sentinel:'secret'})),1,'','shape\n');
  check(run(cwd1,[],'sentinel{'),1,'','argv\n');
  check(run(cwd1,['-','extra'],'sentinel{'),1,'','argv\n');
  check(run(cwd1,['missing.json'],''),1,'','file\n');
});
