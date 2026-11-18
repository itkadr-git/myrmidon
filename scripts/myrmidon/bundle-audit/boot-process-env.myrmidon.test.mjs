import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const marker = 'SYNTHETIC_SECRET_9b47';

function audit(env) {
  const manifest = {
    argv: ['node', 'server/dist/index.js'],
    env: { MYRMIDON_BUILD_VERSION: '1.7.0', MYRMIDON_BUILD_COMMIT: 'abc123', ...env },
  };
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(manifest), encoding: 'utf8', env: { PATH: process.env.PATH },
  });
}

for (const [description, env, category] of [
  ['empty name', { '': marker }, /env name/i],
  ['equals in name', { [`BAD=${marker}`]: 'value' }, /env name/i],
  ['NUL in name', { [`BAD\u0000${marker}`]: 'value' }, /env name/i],
  ['NUL in value', { SAFE: `value\u0000${marker}` }, /env value/i],
]) {
  test(`rejects ${description} without exposing input`, () => {
    const result = audit(env);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, category);
    assert.equal((result.stdout + result.stderr).includes(marker), false);
    assert.doesNotMatch(result.stdout, /PASS/);
  });
}

test('accepts a nonstandard env name and Unicode and spaces in values', () => {
  const result = audit({ 'name.with spaces': '  hello \u4e16\u754c  ', EMPTY: '' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
});
