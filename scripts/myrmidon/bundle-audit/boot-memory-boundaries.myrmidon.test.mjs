import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));

function audit(options) {
  const manifest = {
    argv: ['node', 'server/dist/index.js'],
    env: { MYRMIDON_BUILD_VERSION: '1.7.0', MYRMIDON_BUILD_COMMIT: 'abc123', NODE_OPTIONS: options },
  };
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify(manifest), encoding: 'utf8', env });
  assert.ifError(result.error);
  return result;
}

function expectLimits(options, limits) {
  const result = audit(options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `PASS: boot contract; NODE_OPTIONS=${limits.map((limit) => `--max-old-space-size=${limit}`).join(' ')}`);
}

for (const [options, limits] of [
  ['--max-old-space-size=1', [1]],
  ['--max-old-space-size 1', [1]],
  ['--max-old-space-size=9007199254740991', [9007199254740991]],
  ['--max-old-space-size 9007199254740991', [9007199254740991]],
  ['--max-old-space-size=0001 --max-old-space-size 0009007199254740991', [1, 9007199254740991]],
  ['--max-old-space-size 9007199254740991 --max-old-space-size=1 --max-old-space-size 0001', [9007199254740991, 1, 1]],
]) {
  test(`accepts and normalizes ${options}`, () => expectLimits(options, limits));
}

for (const value of ['0', '-1', '1.5', '1e2', 'NaN', 'Infinity', '9007199254740992', '']) {
  for (const separator of ['=', ' ']) {
    const option = `--max-old-space-size${separator}${value}`;
    test(`rejects ${JSON.stringify(option)} after a valid limit`, () => {
      expectLimits('--max-old-space-size=1', [1]);
      const result = audit(`--max-old-space-size=1 ${option}`);
      assert.notEqual(result.status, 0, option);
      assert.doesNotMatch(result.stdout + result.stderr, /PASS/);
      assert.match(result.stderr, /invalid max-old-space-size/);
    });
  }
}
