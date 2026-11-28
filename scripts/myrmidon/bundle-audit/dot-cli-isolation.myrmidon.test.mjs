import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-dot.mjs', import.meta.url));
const report = '{\r\n  "entry": "caf\u00e9.mjs",\r\n  "modules": [{"path":"caf\u00e9.mjs","bytes":0,"eager":true}],\r\n  "edges": []\r\n}';
const expected = 'digraph imports {\n  n0 [label="caf\u00e9.mjs", style=solid];\n  // unresolved: 0\n}\n';

function run(cwd, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    const bytes = Buffer.from(input);
    const split = bytes.indexOf(Buffer.from('\u00e9')) + 1;
    if (split > 0) {
      child.stdin.write(bytes.subarray(0, split));
      setImmediate(() => child.stdin.end(bytes.subarray(split)));
    } else child.stdin.end(bytes);
  });
}

test('DOT CLI is atomic from two foreign working directories', async () => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || homedir(), 'dot-isolation-'));
  try {
    const directories = [join(scratch, 'first'), join(scratch, 'second')];
    for (const cwd of directories) mkdirSync(cwd);
    for (const cwd of directories) {
      const success = await run(cwd, report);
      assert.deepEqual(success, { status: 0, signal: null, stdout: expected, stderr: '' });
      const cases = [
        ['', [], 'json'],
        ['{"entry":', [], 'json'],
        [report + report, [], 'json'],
        [report, ['unexpected'], 'argv'],
        ['{', ['unexpected'], 'argv'],
      ];
      for (const [input, args, category] of cases) {
        const result = await run(cwd, input, args);
        assert.equal(result.status, 1, `${category} status`);
        assert.equal(result.signal, null, `${category} signal`);
        assert.equal(result.stdout, '', `${category} stdout must be empty`);
        assert.equal(result.stderr, `${category}\n`, `${category} stderr`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
