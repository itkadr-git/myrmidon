import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-condensation.mjs', import.meta.url));
const sentinel = 'DO_NOT_EMIT_SENTINEL';
const report = {
  entry: 'a',
  modules: [{ path: 'a', bytes: 2, eager: true }, { path: 'é', bytes: 3, eager: false }],
  edges: [{ from: 'a', to: 'é', kind: 'eager', specifier: './é' },
    { from: 'é', to: 'a', kind: 'lazy', specifier: './a' }],
  secret: sentinel,
};
// The eager graph is a -> é; adding the lazy return edge makes one SCC.
const expected = {
  eager: '{"entry":"a","components":[{"id":"a","paths":["a"],"bytes":2},{"id":"é","paths":["é"],"bytes":3}],"edges":[{"from":"a","to":"é"}]}\n',
  all: '{"entry":"a","components":[{"id":"a","paths":["a","é"],"bytes":5}],"edges":[]}\n',
};

function start(t, args) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const tmp = mkdtempSync(join(root, 'condensation-stream-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, TMPDIR: tmp }, timeout: 5000 });
  let stdout = '', stderr = '', error;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', err => { error = err; });
  child.stdin.on('error', err => { if (err.code !== 'EPIPE') error = err; });
  const done = new Promise(resolve => child.on('close', (status, signal) => resolve({ status, signal, error, stdout, stderr })));
  return { child, done, output: () => stdout };
}

function check(result, status, stdout, stderr) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
}

test('chunked UTF-8 input is atomic until EOF in both modes', async t => {
  const input = Buffer.from(JSON.stringify(report));
  const split = input.indexOf(Buffer.from('é'));
  assert.ok(split > 0);
  for (const mode of ['eager', 'all']) {
    const run = start(t, [mode]);
    run.child.stdin.write(input.subarray(0, split + 1));
    run.child.stdin.write(input.subarray(split + 1, split + 2));
    run.child.stdin.write(input.subarray(split + 2));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(run.output(), '', 'stdout before EOF');
    run.child.stdin.end();
    const result = await run.done;
    check(result, 0, expected[mode], '');
    assert.throws(() => check(result, 0, expected[mode].replace('"bytes":2', '"bytes":99').replace('"bytes":5', '"bytes":99'), ''));
  }
});

test('JSON framing, whitespace and argument errors use exact channels', async t => {
  const valid = JSON.stringify(report);
  const cases = [
    [['eager'], valid + ' \n\t', 0, expected.eager, ''],
    [['eager'], valid + valid, 1, '', 'json\n'],
    [['eager'], ' \n\t', 1, '', 'json\n'],
    [['eager'], '', 1, '', 'json\n'],
    [['eager'], valid.slice(0, -1), 1, '', 'json\n'],
    [[], '{broken', 1, '', 'argv\n'],
    [['bad'], '{broken', 1, '', 'argv\n'],
    [['all', 'extra'], '{broken', 1, '', 'argv\n'],
  ];
  for (const [args, input, status, stdout, stderr] of cases) {
    const run = start(t, args);
    run.child.stdin.end(input);
    check(await run.done, status, stdout, stderr);
  }
});
