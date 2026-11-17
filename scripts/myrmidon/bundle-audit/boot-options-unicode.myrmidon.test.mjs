import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const first = '--max-old-space-size=64';
const second = '--max-old-space-size=128';

function audit(options) {
  const manifest = {
    argv: ['node', 'server/dist/index.js'],
    env: { MYRMIDON_BUILD_VERSION: '1.7', MYRMIDON_BUILD_COMMIT: 'abc', NODE_OPTIONS: options },
  };
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(manifest), encoding: 'utf8', env });
}

test('rejects Unicode whitespace between memory options without exposing input', () => {
  for (const separator of ['\u00a0', '\u2003', '\u2028', '\u2029', '\ufeff']) {
    for (const suffix of [second, `${second} SYNTHETIC_SECRET_7d18`]) {
      const result = audit(first + separator + suffix);
      assert.ifError(result.error);
      assert.equal(result.status, 1, `separator U+${separator.codePointAt(0).toString(16)}`);
      assert.doesNotMatch(result.stdout, /PASS/);
      assert.match(result.stderr, /NODE_OPTIONS/);
      assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_SECRET_7d18/);
    }
  }
});

test('normalizes two memory options separated by ASCII space', () => {
  const result = audit(`${first} ${second}`);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `PASS: boot contract; NODE_OPTIONS=${first} ${second}\n`);
  assert.equal(result.stderr, '');
});
