import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "verify-release-registry-state.mjs");
const base = ["--channel", "stable", "--dist-tag", "latest", "--target-version", "1.2.3", "--package", "@myrmidon/example"];

// Preload before the CLI so even an accidental registry override cannot resolve
// DNS or connect outside the fixture. The CLI has no need to launch npm.
const guard = `
const net = require('node:net');
const dns = require('node:dns');
const child = require('node:child_process');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' ? first : { port: first, host: args[1] };
  if (opts.host !== '127.0.0.1' || Number(opts.port) !== Number(process.env.FIXTURE_PORT)) {
    throw new Error('Blocked non-fixture network connection');
  }
  return original.apply(this, args);
};
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
  dns[key] = () => { throw new Error('Blocked DNS'); };
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  child[key] = () => { throw new Error('Blocked subprocess'); };
}
`;

async function run(args, registry, port, preload, scratch) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, cli, ...args], {
      env: { PATH: scratch, HOME: scratch, TMPDIR: scratch, npm_config_registry: registry, FIXTURE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('registry CLI validates before any registry request', async (t) => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.myrmidon-scratch');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, 'registry-cli-'));
  const preload = join(scratch, 'network-guard.cjs');
  await writeFile(preload, guard);
  const requests = [];
  let stale = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/%40myrmidon%2Fexample') {
      res.end(JSON.stringify({ 'dist-tags': { latest: stale ? '1.2.2' : '1.2.3' } }));
    } else if (req.url === '/%40myrmidon%2Fexample/1.2.3') {
      res.end(JSON.stringify({ name: '@myrmidon/example', version: '1.2.3' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const registry = `http://127.0.0.1:${port}/`;
    const cases = [
      ['unknown channel', ['--channel', 'unknown', ...base.slice(2)], '--channel must be canary, nightly, beta, or stable'],
      ['missing dist-tag', ['--channel', 'stable', ...base.slice(4)], '--dist-tag is required'],
      ['missing target-version', [...base.slice(0, 4), ...base.slice(6)], '--target-version is required'],
      ['no package', base.slice(0, 6), 'at least one non-empty --package value is required'],
      ['empty package', [...base.slice(0, 6), '--package', ''], 'at least one non-empty --package value is required'],
      ['unknown argument', [...base, '--unknown'], 'unexpected argument: --unknown'],
      ...['stable', 'nightly', 'beta'].map((channel) => [`allow canary latest on ${channel}`, ['--channel', channel, ...base.slice(2), '--allow-canary-latest'], '--allow-canary-latest only applies to canary releases']),
    ];
    for (const [name, args, diagnostic] of cases) {
      await t.test(name, async () => {
        requests.length = 0;
        const result = await run(args, registry, port, preload, scratch);
        assert.deepEqual(result, { code: 2, signal: null, stdout: '', stderr: `Error: ${diagnostic}\n` });
        assert.deepEqual(requests, []);
      });
    }
    await t.test('help', async () => {
      requests.length = 0;
      const result = await run(['--help'], registry, port, preload, scratch);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Usage:\n  node scripts\/verify-release-registry-state\.mjs --channel /);
      assert.deepEqual(requests, []);
    });
    await t.test('valid stable fetches metadata and manifest', async () => {
      requests.length = 0;
      const result = await run(base, registry, port, preload, scratch);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '  Verifying @myrmidon/example on dist-tag latest\n    ✓ dist-tag and published internal dependencies are consistent\n');
      assert.deepEqual(requests, ['GET /%40myrmidon%2Fexample', 'GET /%40myrmidon%2Fexample/1.2.3']);
    });
    await t.test('stale metadata is rejected', async () => {
      stale = true;
      requests.length = 0;
      const result = await run(base, registry, port, preload, scratch);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /dist-tag latest resolves to 1\.2\.2, expected 1\.2\.3/);
      assert.deepEqual(requests, ['GET /%40myrmidon%2Fexample', 'GET /%40myrmidon%2Fexample/1.2.3']);
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
