import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-fan-out.mjs', import.meta.url));
const sentinel = 'synthetic-secret-sentinel';
const report = { entry: 'a', modules: [{ path: 'a', bytes: 1, eager: true }], edges: [] };
const output = '{"entry":"a","modules":[{"path":"a","bytes":1,"targets":[],"fanOut":0}]}\n';

function fixture(t) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'fan-out-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'working space \u00e9');
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  for (const dir of [cwd, home, tmp]) mkdirSync(dir);
  const env = { ...process.env, HOME: home, TMPDIR: tmp };
  return { root, cwd, env };
}
function snapshot(root) {
  const walk = dir => readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) return [[path, 'dir'], ...walk(path)];
    if (stat.isSymbolicLink()) return [[path, 'symlink']];
    return [[path, 'file', readFileSync(path).toString('base64')]];
  });
  return walk(root);
}
function check(result, status, stdout, stderr) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.ok(!result.stderr.includes(sentinel), 'stderr must not disclose input');
  assert.equal(result.stderr, stderr);
}

test('absolute CLI is fail-closed in an isolated Unicode working directory', t => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const run = (input, args = []) => spawnSync(process.execPath, [cli, ...args], {
    cwd: f.cwd, env: f.env, input, encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  check(run(JSON.stringify(report)), 0, output, '');
  check(run('', [sentinel]), 1, '', 'argv\n');
  check(run(''), 1, '', 'json\n');
  check(run(`{${sentinel}`), 1, '', 'json\n');
  const badShape = [null, [], 42, 'text', {},
    {...report, entry: ''}, {...report, modules: null}, {...report, modules: []}, {...report, edges: null},
    {...report, modules: [null]}, {...report, modules: [{...report.modules[0], path: ''}]},
    {...report, modules: [{...report.modules[0], bytes: -1}]},
    {...report, modules: [{...report.modules[0], bytes: 1.5}]},
    {...report, modules: [{...report.modules[0], eager: sentinel}]},
    {...report, edges: [null]}, {...report, edges: [{from:'', specifier:'x', kind:'eager', to:null}]},
    {...report, edges: [{from:'a', specifier:null, kind:'eager', to:null}]},
    {...report, edges: [{from:'a', specifier:'x', kind:sentinel, to:null}]},
    {...report, edges: [{from:'a', specifier:'x', kind:'eager', to:''}]},
  ];
  const edge = {from:'a', specifier:'x', kind:'eager', to:'a'};
  const badGraph = [
    {...report, entry: sentinel}, {...report, modules: [...report.modules, report.modules[0]]},
    {...report, edges: [{...edge, from: sentinel}]}, {...report, edges: [{...edge, to: sentinel}]},
    {...report, edges: [edge, edge]},
  ];
  for (const value of badShape) check(run(JSON.stringify(value)), 1, '', 'shape\n');
  for (const value of badGraph) check(run(JSON.stringify(value)), 1, '', 'graph\n');
  assert.deepEqual(snapshot(f.root), before);
});

test('fragmented UTF-8 stdin is decoded across writes without scratch writes', async t => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const child = spawn(process.execPath, [cli], {cwd:f.cwd, env:f.env, shell:false, timeout:5000, stdio:['pipe','pipe','pipe']});
  const bytes = Buffer.from(JSON.stringify({entry:'\u00e9', modules:[{path:'\u00e9',bytes:1,eager:true}], edges:[]}));
  let stdout = '', stderr = '', error;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) child.kill(); });
  child.on('error', e => { error = e; });
  const done = new Promise(resolve => child.on('close', (status, signal) => resolve({status, signal})));
  const split = bytes.indexOf(Buffer.from('\u00e9')) + 1;
  child.stdin.write(bytes.subarray(0, split));
  await new Promise(resolve => setTimeout(resolve, 20));
  child.stdin.end(bytes.subarray(split));
  const result = await done;
  check({...result, error, stdout, stderr}, 0, '{"entry":"\u00e9","modules":[{"path":"\u00e9","bytes":1,"targets":[],"fanOut":0}]}\n', '');
  assert.deepEqual(snapshot(f.root), before);
});
