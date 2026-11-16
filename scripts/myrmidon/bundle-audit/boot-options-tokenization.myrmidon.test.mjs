import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const prefix = '"--max-old-space-size=02048"';

function audit(options) {
  const manifest = {
    argv: ['node', 'server/dist/index.js'],
    env: { MYRMIDON_BUILD_VERSION: '1.7.0', MYRMIDON_BUILD_COMMIT: 'abc123', NODE_OPTIONS: options },
  };
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [cli], { input: JSON.stringify(manifest), encoding: 'utf8', env });
}

function accepts(options, normalized) {
  const result = audit(options);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `PASS: boot contract; NODE_OPTIONS=${normalized}\n`);
  assert.equal(result.stderr, '');
}

function rejects(options, marker) {
  const result = audit(options);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, options);
  assert.doesNotMatch(result.stdout + result.stderr, /PASS/);
  assert.match(result.stderr, /FAIL:.*NODE_OPTIONS/);
  if (marker) assert.equal((result.stdout + result.stderr).includes(marker), false);
}

test('normalizes quoted memory options across whitespace boundaries', () => {
  accepts(` \t\n${prefix}\r\n  `, '--max-old-space-size=2048');
  accepts(`\t${prefix}\n"--max-old-space-size=4096" `, '--max-old-space-size=2048 --max-old-space-size=4096');
});

test('rejects malformed quoting and an unknown tail after a valid prefix', () => {
  accepts(prefix, '--max-old-space-size=2048');
  for (const suffix of [' "--max-old-space-size=4096', ' \\--max-old-space-size=4096', " '--max-old-space-size=4096'", ' ""', ' --unknown']) {
    rejects(prefix + suffix);
  }
});

test('redacts loader and import values following a valid quoted prefix', () => {
  for (const [flag, marker] of [['--loader', 'loader-marker-value'], ['--import', 'import-marker-value']]) {
    rejects(`${prefix}\t"${flag}=${marker}"`, marker);
    rejects(`${prefix}\n${flag} ${marker}`, marker);
  }
});
