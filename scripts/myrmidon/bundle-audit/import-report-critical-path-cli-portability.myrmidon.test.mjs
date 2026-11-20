import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const sentinel = 'SYNTHETIC_SECRET_SENTINEL';
const good = { entry: 'a', modules: [{ path: 'a', bytes: 3, eager: true }], edges: [] };
const unicode = { entry: '\u00e9', modules: [{ path: '\u00e9', bytes: 3, eager: true }], edges: [] };
const options = (cwd, root) => ({ cwd, env: { ...process.env, HOME: root, TMPDIR: root }, shell: false, timeout: 10000, maxBuffer: 1024 * 1024 });

function snapshot(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? [[name, 'directory'], ...snapshot(root, name)] : [[name, readFileSync(join(root, name)).toString('base64')]];
  });
}

function sandbox(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(base, 'critical-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'working \u7a7a\u767d');
  mkdirSync(cwd);
  const fixture = join(root, 'fixture.json');
  writeFileSync(fixture, JSON.stringify(good));
  return { root, cwd, fixture };
}

function check(result, status, stdout, stderr) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout, 'stdout must be exact, with no partial output');
  assert.equal(result.stderr, stderr, 'stderr must be the exact sanitized channel');
}

 test('absolute CLI path from Unicode cwd has exact error protocol and no writes', t => {
  const { root, cwd, fixture } = sandbox(t);
  const before = snapshot(root);
  const input = readFileSync(fixture, 'utf8');
  const duplicate = { from: 'a', specifier: sentinel, kind: 'eager', to: 'a' };
  const cases = [
    ['extra argument', input, [sentinel], 'argv'],
    ['help argument', input, ['--help'], 'argv'],
    ['malformed', `{${sentinel}`, [], 'json'],
    ['trailing JSON', `${input} ${JSON.stringify(sentinel)}`, [], 'json'],
    ['invalid schema', JSON.stringify({ ...good, entry: sentinel, modules: null }), [], 'shape'],
    ['broken reference', JSON.stringify({ ...good, entry: sentinel }), [], 'graph'],
    ['duplicate tuple', JSON.stringify({ ...good, edges: [duplicate, duplicate] }), [], 'graph'],
  ];
  for (const [label, data, args, category] of cases) {
    const result = spawnSync(process.execPath, [cli, ...args], { ...options(cwd, root), input: data, encoding: 'utf8' });
    assert.doesNotThrow(() => check(result, 1, '', `${category}\n`), label);
    assert.deepEqual(snapshot(root), before, `${label}: scratch tree changed`);
    assert.equal(readFileSync(fixture, 'utf8'), input, `${label}: fixture changed`);
  }
});

test('split UTF-8 stdin completes on EOF with exact output and no writes', async t => {
  const { root, cwd, fixture } = sandbox(t);
  const before = snapshot(root);
  const fixtureBefore = readFileSync(fixture, 'utf8');
  const input = Buffer.from(JSON.stringify(unicode));
  const split = input.indexOf(Buffer.from('\u00e9')) + 1;
  assert.ok(split > 1);
  const child = spawn(process.execPath, [cli], { ...options(cwd, root), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stdout = '', stderr = '', error;
  child.stdin.on('error', err => { error = err; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) child.kill(); });
  child.on('error', err => { error = err; });
  const closed = new Promise(resolve => child.on('close', (status, signal) => resolve({ status, signal })));
  const assertWaiting = async stage => {
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(error, undefined, `${stage}: subprocess error`);
    assert.equal(child.exitCode, null, `${stage}: exited before EOF`);
    assert.equal(child.signalCode, null, `${stage}: signalled before EOF`);
    assert.equal(stdout, '', `${stage}: stdout before EOF`);
    assert.equal(stderr, '', `${stage}: stderr before EOF`);
  };
  child.stdin.write(input.subarray(0, split));
  await assertWaiting('split UTF-8');
  child.stdin.write(input.subarray(split));
  await assertWaiting('complete JSON');
  child.stdin.end();
  const result = await closed;
  check({ ...result, error, stdout, stderr }, 0, '{"entry":"\u00e9","paths":["\u00e9"],"bytes":3}\n', '');
  assert.deepEqual(snapshot(root), before);
  assert.equal(readFileSync(fixture, 'utf8'), fixtureBefore);
});
