import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./import-report-limits.mjs', import.meta.url));
const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir();
const sentinel = 'private-sentinel';
const report = {
  modules: [
    { path: sentinel, bytes: 5, eager: true },
    { path: 'b', bytes: 7, eager: true },
    { path: 'lazy', bytes: 100, eager: false },
  ],
  counts: { eagerModules: 2 },
  bytes: { eager: 12 },
};
const args = (bytes, modules) => ['--max-eager-bytes', String(bytes), '--max-eager-modules', String(modules)];

function run(argv, input, cwd) {
  const result = spawnSync(process.execPath, [cli, ...argv], {
    cwd,
    env: { ...process.env, TMPDIR: scratchRoot },
    input,
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.ok(!result.stderr.includes(sentinel));
  return result;
}

test('stdin protocol and argv precedence are identical in two foreign directories', t => {
  const firstCwd = mkdtempSync(join(scratchRoot, 'limits-stdin-first-'));
  t.after(() => rmSync(firstCwd, { recursive: true, force: true }));
  const secondCwd = mkdtempSync(join(scratchRoot, 'limits-stdin-second-'));
  t.after(() => rmSync(secondCwd, { recursive: true, force: true }));

  const json = JSON.stringify(report);
  const invalidInputs = ['', ' \n\t ', `{"path":"${sentinel}",`, `${json}\n${json}`];
  for (const cwd of [firstCwd, secondCwd]) {
    for (const input of invalidInputs) {
      const result = run(args(100, 100), input, cwd);
      assert.equal(result.status, 2, `${cwd}: ${JSON.stringify(input)}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'report error\n');

      const invalidArgs = run(['--max-eager-bytes', '100', '--max-eager-modules', sentinel], input, cwd);
      assert.equal(invalidArgs.status, 2);
      assert.equal(invalidArgs.stdout, '');
      assert.equal(invalidArgs.stderr, 'argv error\n');
    }

    const violation = run(args(11, 2), `${json} \n\t`, cwd);
    assert.equal(violation.status, 1);
    assert.equal(violation.stdout, `${JSON.stringify({ ok: false, eagerBytes: 12, eagerModules: 2, maxEagerBytes: 11, maxEagerModules: 2, violations: ['eagerBytes'] })}\n`);
    assert.equal(violation.stderr, '');

    const within = run(args(12, 2), `${json} \n\t`, cwd);
    assert.equal(within.status, 0);
    assert.equal(within.stdout, `${JSON.stringify({ ok: true, eagerBytes: 12, eagerModules: 2, maxEagerBytes: 12, maxEagerModules: 2, violations: [] })}\n`);
    assert.equal(within.stderr, '');
  }
});
