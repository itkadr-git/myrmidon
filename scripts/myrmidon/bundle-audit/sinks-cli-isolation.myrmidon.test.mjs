import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-sinks.mjs', import.meta.url));
const sentinel = 'SINKS_SECRET_SENTINEL_9427';
const graph = '{"entry":"\u96ea","modules":[{"path":"\u96ea","bytes":4,"eager":true},{"path":"leaf","bytes":7,"eager":true}],"edges":[{"from":"\u96ea","to":"leaf","kind":"eager","specifier":"leaf"}]}';
const expected = '{"entry":"\u96ea","sinks":[{"path":"leaf","bytes":7}],"sinkBytes":7}\n';

function run(cwd, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, SINKS_TEST_SECRET: sentinel },
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    for (const chunk of input) child.stdin.write(chunk);
    child.stdin.end();
  });
}

test('CLI is portable and atomic across foreign working directories and stdin boundaries', async () => {
  const root = await mkdtemp(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'sinks-cli-'));
  try {
    const dirs = [join(root, 'foreign space'), join(root, 'foreign \u96ea space')];
    await Promise.all(dirs.map(dir => mkdir(dir)));
    const bytes = Buffer.from(graph);
    const split = bytes.indexOf(Buffer.from('\u96ea')) + 1;
    const cases = [
      { name: 'fragmented UTF-8 without trailing LF', input: [bytes.subarray(0, split), bytes.subarray(split, split + 1), bytes.subarray(split + 1)], status: 0, stdout: expected, stderr: '' },
      { name: 'CRLF', input: [Buffer.from(graph + '\r\n')], status: 0, stdout: expected, stderr: '' },
      { name: 'empty stdin', input: [], status: 1, stdout: '', stderr: 'json\n' },
      { name: 'truncated JSON', input: [Buffer.from('{"entry":"' + sentinel)], status: 1, stdout: '', stderr: 'json\n' },
      { name: 'two JSON documents', input: [Buffer.from(graph + '\n' + graph)], status: 1, stdout: '', stderr: 'json\n' },
      { name: 'argv takes precedence over bad JSON', input: [Buffer.from('{' + sentinel)], args: [sentinel], status: 1, stdout: '', stderr: 'argv\n' },
    ];
    for (const cwd of dirs) {
      for (const fixture of cases) {
        const actual = await run(cwd, fixture.input, fixture.args);
        assert.equal(actual.signal, null, fixture.name);
        assert.equal(actual.status, fixture.status, fixture.name);
        assert.equal(actual.stdout, fixture.stdout, fixture.name);
        assert.equal(actual.stderr, fixture.stderr, fixture.name);
        assert.ok(!actual.stderr.includes(sentinel), fixture.name);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
