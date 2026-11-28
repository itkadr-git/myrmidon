import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/myrmidon-ci.yml'), 'utf8');
const step = workflow.match(/      - name: Scan serialization VM test\n        run: \|\n((?:          .*\n)+)/)?.[1]
  ?.split('\n').map((line) => line.slice(10)).join('\n');

function runStep(present, exitCode = 0) {
  assert.ok(step, 'CI must contain the scan serialization VM test step');
  const dir = mkdtempSync(join(tmpdir(), 'scan-ci-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    if (present) writeFileSync(join(dir, 'scripts/dev-runner.scan-serialization.test.mjs'), '');
    writeFileSync(join(dir, 'bin/node'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CALL_LOG"\nexit "$NODE_EXIT"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', 'export PATH="$TEST_PATH"\n' + step], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TEST_PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, CALL_LOG: join(dir, 'calls'), NODE_EXIT: String(exitCode) },
    });
    let calls = '';
    try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('absent test does not fail or invoke node', () => {
  const { result, calls } = runStep(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls, '');
});

test('present test runs with VM modules and propagates failure', () => {
  const { result, calls } = runStep(true, 7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(calls, '--experimental-vm-modules\n--test\nscripts/dev-runner.scan-serialization.test.mjs\n');
});
