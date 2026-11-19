import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-cut-impact.mjs', import.meta.url));
const input = JSON.stringify({ entry: 'entry', modules: [
  { path: 'entry', bytes: 2, eager: true },
  { path: 'café', bytes: 5, eager: true },
], edges: [{ from: 'entry', specifier: 'café', kind: 'eager', to: 'café' }] });
const expected = '{"entry":"entry","removed":"café","lostPaths":["café"],"lostBytes":5}\n';

function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).sort().map(name => {
    const path = join(dir, name);
    const stat = statSync(path);
    return [name, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(path).toString('base64') : null];
  });
}

function fixture(t) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache');
  const dir = mkdtempSync(join(root, 'cut-impact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sentinel.txt'), 'synthetic-sentinel');
  return dir;
}

function run(cwd, args, data = input) {
  const before = snapshot(cwd);
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, input: data, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.deepEqual(snapshot(cwd), before);
  return result;
}

function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

test('absolute CLI path validates arguments and JSON without filesystem side effects', { timeout: 30000 }, t => {
  const cwd = fixture(t);
  for (const args of [[], ['café', 'extra'], [''], ['absent']]) failure(run(cwd, args), 'argv');
  for (const data of ['', '{synthetic-sentinel', `${input} trailing-synthetic-sentinel`]) failure(run(cwd, ['café'], data), 'json');
  const result = run(cwd, ['café']);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
});

async function chunked(cwd, tail) {
  const before = snapshot(cwd);
  const bytes = Buffer.from(input);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  assert.ok(split > 0);
  const child = spawn(process.execPath, [cli, 'café'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    child.stdin.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 40));
    child.stdin.write(bytes.subarray(split));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(stdout, '', 'no output before stdin closes');
    child.stdin.end(tail);
    const result = await done;
    assert.deepEqual(snapshot(cwd), before);
    return result;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

test('split UTF-8 stdin succeeds and late malformed tail never emits partial output', { timeout: 30000 }, async t => {
  const cwd = fixture(t);
  const success = await chunked(cwd, '');
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal(success.stderr, '');
  assert.equal(success.stdout, expected);
  failure(await chunked(cwd, ' synthetic-sentinel'), 'json');
});
