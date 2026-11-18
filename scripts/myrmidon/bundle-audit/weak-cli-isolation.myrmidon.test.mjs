import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const input = Buffer.from('{"entry":"caf\u00e9","modules":[{"path":"caf\u00e9","bytes":7,"eager":true}],"edges":[]}');
const expected = '{"entry":"caf\u00e9","components":[{"id":"caf\u00e9","paths":["caf\u00e9"],"bytes":7}]}\n';
const maxBuffer = 64 * 1024;

function run(script, cwd, args, chunks) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const output = { stdout: [], stderr: [] };
    let size = 0, failure;
    const timer = setTimeout(() => { failure = new Error('child timed out after 30s'); child.kill(); }, 30000);
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      size += chunk.length;
      if (size > maxBuffer) { failure = new Error('child output exceeded maxBuffer'); child.kill(); }
      else output[name].push(chunk);
    });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ status, signal, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() });
    });
    (async () => {
      for (const chunk of chunks) {
        if (child.stdin.destroyed) break;
        child.stdin.write(chunk);
        await delay(10);
      }
      if (!child.stdin.destroyed) child.stdin.end();
    })().catch(error => { failure = error; child.kill(); });
  });
}

function success(result) {
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expected);
}

function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${category}\n`);
}

test('CLI is atomic and portable across scratch directories', async () => {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-cli-'));
  try {
    const directories = [join(root, 'plain'), join(root, 'with space')];
    for (const cwd of directories) {
      await mkdir(cwd);
      await writeFile(join(cwd, 'existing.txt'), 'unchanged');
      const before = await readdir(cwd, { recursive: true });
      for (const mode of ['eager', 'all']) success(await run(cli, cwd, [mode], [input]));
      for (const args of [[], ['invalid'], ['all', 'extra']]) failure(await run(cli, cwd, args, [input]), 'argv');
      for (const bad of ['', '{synthetic-payload', '{}{}']) failure(await run(cli, cwd, ['all'], [Buffer.from(bad)]), 'json');
      const unicode = input.indexOf(Buffer.from('\u00e9'));
      const token = input.indexOf(Buffer.from('modules')) + 3;
      success(await run(cli, cwd, ['all'], [input.subarray(0, unicode + 1), input.subarray(unicode + 1, token), input.subarray(token)]));
      assert.deepEqual(await readdir(cwd, { recursive: true }), before);
      assert.equal(await readFile(join(cwd, 'existing.txt'), 'utf8'), 'unchanged');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('negative control: a banner is rejected by the exact stdout assertion', async () => {
  const root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'weak-cli-control-'));
  try {
    const mutant = join(root, 'mutant.mjs');
    const source = await readFile(cli, 'utf8');
    await writeFile(mutant, source.replace('process.stdout.write(`${JSON.stringify', 'process.stdout.write(`banner\\n${JSON.stringify'));
    const result = await run(mutant, root, ['all'], [input]);
    assert.throws(() => success(result), { code: 'ERR_ASSERTION' });
    assert.equal(result.stdout, `banner\n${expected}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
