import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cli = process.env.MYRMIDON_TEST_CLI ?? fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const name = 'caf\u00e9"entry';
const report = { entry: name, modules: [{ path: name, bytes: 0, eager: true }], edges: [] };
const expected = { entry: name, modules: [{ path: name, depth: 0, shortestPaths: '1' }], unreachable: [] };

async function run(chunks, beforeEof = false) {
  const child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  try {
    for (const chunk of chunks) {
      if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, 'drain'), closed.then(() => { throw new Error('child closed before EOF'); })]);
      if (beforeEof) {
        // SIOCOUTQ on the pipe's socket is zero only after the child consumes the bytes.
        const fd = child.stdin._handle.fd;
        for (;;) {
          const probe = spawn('python3', ['-c', 'import fcntl,struct; print(struct.unpack("I", fcntl.ioctl(3, 0x5411, bytes(4)))[0])'], { stdio: ['ignore', 'pipe', 'inherit', fd] });
          const probeClosed = once(probe, 'close');
          let queued = '';
          for await (const data of probe.stdout) queued += data;
          const [status] = await probeClosed;
          assert.equal(status, 0, 'socket queue probe failed');
          if (Number(queued) === 0) break;
          if (timedOut || child.exitCode !== null || child.signalCode !== null) throw new Error('child closed before EOF');
        }
      }
    }
    if (beforeEof) {
      // More than the pipe capacity forces the child to consume the complete document.
      if (!child.stdin.write(Buffer.alloc(1024 * 1024, 0x20))) {
        await Promise.race([once(child.stdin, 'drain'), closed.then(() => { throw new Error('child closed before EOF'); })]);
      }
      assert.equal(stdout, '', 'stdout must remain empty before EOF');
    }
    child.stdin.end();
    const [code, signal] = await closed;
    assert.equal(timedOut, false, 'child timed out');
    return { code, signal, stdout, stderr };
  } catch (error) {
    if (error.code === 'EPIPE' || error.message === 'child closed before EOF') {
      assert.fail('child closed stdin before EOF');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}

test('chunked UTF-8 and escaped JSON are atomic until EOF', async () => {
  const data = Buffer.from(JSON.stringify(report));
  const utf8 = data.indexOf(Buffer.from('\u00e9'));
  const escape = data.indexOf(Buffer.from('\\"'));
  assert.ok(utf8 >= 0 && escape > utf8);
  const result = await run([data.subarray(0, utf8 + 1), data.subarray(utf8 + 1, escape + 1), data.subarray(escape + 1)], true);
  assert.deepEqual(result, { code: 0, signal: null, stdout: `${JSON.stringify(expected)}\n`, stderr: '' });
});

test('leading and trailing JSON whitespace is accepted', async () => {
  const result = await run([` \n\t${JSON.stringify(report)}\r\n `]);
  assert.deepEqual(result, { code: 0, signal: null, stdout: `${JSON.stringify(expected)}\n`, stderr: '' });
});

for (const [label, input] of [
  ['empty', ''],
  ['truncated', '{"entry":'],
  ['concatenated documents', JSON.stringify(report) + JSON.stringify(report)],
  ['trailing garbage', JSON.stringify(report) + ' garbage'],
]) {
  test(`rejects ${label} without stdout`, async () => {
    assert.deepEqual(await run([input]), { code: 1, signal: null, stdout: '', stderr: 'json\n' });
  });
}
