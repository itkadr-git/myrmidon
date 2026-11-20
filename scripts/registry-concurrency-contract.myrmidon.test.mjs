import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./release-registry-versions.mjs", import.meta.url));
const packages = ["@fixture/a", "@fixture/b", "@fixture/c", "@fixture/d", "@fixture/e"];
const versions = Object.fromEntries(packages.map((name, i) => [name, i === 2 ? [] : [`${i + 1}.0.0`, `${i + 1}.1.0`]]));

// The fixture is an executable, not a wrapper around the real npm.
const fakeNpm = `#!${process.execPath}
const net = require('node:net');
const socket = net.createConnection(process.env.FIXTURE_SOCKET);
socket.on('connect', () => socket.write(JSON.stringify(process.argv.slice(2)) + '\\n'));
socket.setEncoding('utf8');
let data = '';
socket.on('data', chunk => { data += chunk; if (data.includes('\\n')) { const reply = JSON.parse(data); if (reply.output !== null) process.stdout.write(reply.output); socket.end(); } });
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

async function exercise(limit, replacement) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'registry-contract-'));
  let child;
  let server;
  const sockets = new Set();
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'npm'), fakeNpm, { mode: 0o755 });
    let script = cli;
    if (replacement) {
      script = join(dir, 'control.mjs');
      await writeFile(script, replacement);
    }
    const socketPath = join(dir, 'npm.sock');
    const starts = [];
    const completions = [];
    const errors = [];
    let running = 0;
    let maximum = 0;
    let held;
    let releasedSecond = false;
    const release = (entry) => {
      completions.push(entry.name);
      entry.socket.end(JSON.stringify({ output: entry.name === packages[2] ? null : JSON.stringify(versions[entry.name]) }) + '\n');
    };
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', (error) => errors.push(error.message));
      socket.on('close', () => sockets.delete(socket));
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
        if (!input.includes('\n')) return;
        socket.removeAllListeners('data');
        let args;
        try { args = JSON.parse(input); } catch { errors.push('invalid request'); socket.destroy(); return; }
        const name = args[1];
        if (args.length !== 4 || args[0] !== 'view' || args[2] !== 'versions' || args[3] !== '--json' || !packages.includes(name)) {
          errors.push(`unexpected npm request: ${JSON.stringify(args)}`);
          socket.destroy();
          return;
        }
        starts.push(name);
        running += 1;
        maximum = Math.max(maximum, running);
        socket.once('close', () => { running -= 1; });
        const entry = { name, socket };
        if (limit === 2 && starts.length === 1) held = entry;
        else if (limit === 2 && starts.length === 2) { releasedSecond = true; release(entry); }
        else {
          release(entry);
          if (held && releasedSecond) { release(held); held = null; }
        }
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    child = spawn(process.execPath, [script, 'fetch', ...packages], {
      env: { PATH: bin, FIXTURE_SOCKET: socketPath, RELEASE_REGISTRY_CONCURRENCY: String(limit) },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    let code, signal;
    try { [code, signal] = await once(child, 'close'); } finally { clearTimeout(timer); }
    assert.equal(signal, null, `CLI timed out or was signalled: ${stderr}`);
    assert.equal(code, 0, stderr);
    assert.deepEqual(errors, []);
    assert.deepEqual([...starts].sort(), [...packages].sort(), 'every package dispatched exactly once');
    assert.equal(running, 0, 'all workers drained');
    assert.ok(maximum <= limit, `maximum ${maximum} exceeds ${limit}`);
    if (limit === 2) {
      assert.equal(maximum, 2, 'two workers overlap');
      assert.notDeepEqual(completions, starts, 'workers complete out of order');
    }
    assert.deepEqual(JSON.parse(stdout), versions);
    assert.equal(stderr, '');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
}

for (const limit of [1, 2]) {
  test(`fetch preserves package identity with concurrency ${limit}`, { timeout: 10000 }, async () => {
    await exercise(limit);
  });
}

test('negative controls reject a no-op and constant result', { timeout: 15000 }, async () => {
  await assert.rejects(exercise(1, 'console.log("{}")'), /every package dispatched exactly once/);
  const constant = `import { execFileSync } from 'node:child_process';\nfor (const name of process.argv.slice(3)) execFileSync('npm', ['view', name, 'versions', '--json']);\nconsole.log(JSON.stringify(Object.fromEntries(process.argv.slice(3).map(name => [name, ['1.0.0']]))));`;
  await assert.rejects(exercise(1, constant), /Expected values to be strictly deep-equal/);
});
