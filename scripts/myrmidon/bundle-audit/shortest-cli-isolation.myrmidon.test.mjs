import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-shortest-counts.mjs', import.meta.url));
const secret = randomBytes(24).toString('hex');
const input = JSON.stringify({
  entry: 'entry',
  modules: [{ path: 'entry', bytes: 0, eager: true }, { path: 'leaf', bytes: 2, eager: true }, { path: 'unused', bytes: 1, eager: false }],
  edges: [{ from: 'entry', to: 'leaf', kind: 'eager', specifier: './leaf' }],
});
const expected = '{"entry":"entry","modules":[{"path":"entry","depth":0,"shortestPaths":"1"},{"path":"leaf","depth":1,"shortestPaths":"1"}],"unreachable":["unused"]}\n';

function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [entry.name, snapshot(path)] : [entry.name, readFileSync(path).toString('base64')];
  });
}

test('absolute CLI is cwd-independent, rejects argv before stdin, and leaves cwd untouched', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
  const root = mkdtempSync(join(scratch, 'shortest-isolation-'));
  try {
    const dirs = [join(root, 'first'), join(root, 'second with spaces')];
    for (const dir of dirs) {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'sentinel.txt'), `sentinel ${secret}\n`);
      writeFileSync(join(dir, 'nested', 'keep.bin'), Buffer.from([0, 1, 255]));
      const before = snapshot(dir);
      const run = (args, stdin) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, input: stdin, encoding: 'utf8', timeout: 5000 });
      for (const arg of ['--help', 'unexpected', '--unknown-option']) {
        const result = run([arg], `{invalid ${secret}`);
        assert.ifError(result.error);
        assert.equal(result.status, 1, `argv ${arg} in ${dir}`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'argv\n');
        assert.ok(!result.stderr.includes(secret));
      }
      const result = run([], input);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
      assert.deepEqual(snapshot(dir), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
