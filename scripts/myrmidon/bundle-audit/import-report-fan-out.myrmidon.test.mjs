import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const report = {entry:'a',modules:[{path:'a',bytes:1,eager:true},{path:'b',bytes:2,eager:true}],edges:[{from:'a',specifier:'b',kind:'eager',to:'b'}]};
test('reports direct eager dependencies', () => {
  const r = spawnSync(process.execPath, [cli], {input:JSON.stringify(report),encoding:'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, JSON.stringify({entry:'a',modules:[{path:'a',bytes:1,targets:['b'],fanOut:1},{path:'b',bytes:2,targets:[],fanOut:0}]})+'\n');
});
