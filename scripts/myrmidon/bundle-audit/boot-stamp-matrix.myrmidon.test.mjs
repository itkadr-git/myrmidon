import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const valid = {
  argv: ['node', 'server/dist/index.js'],
  env: {
    MYRMIDON_BUILD_VERSION: '1.7.0',
    MYRMIDON_BUILD_COMMIT: 'abc123',
  },
};

function audit(manifest) {
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(manifest),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

function withStamp(name, value) {
  const manifest = structuredClone(valid);
  manifest.env[name] = value;
  return manifest;
}

const invalidStamps = [
  null,
  42,
  true,
  '',
  '   ',
  ' unknown ',
  'NULL',
  '\tUndefined\n',
  ' uNkNoWn ',
];

for (const name of ['MYRMIDON_BUILD_VERSION', 'MYRMIDON_BUILD_COMMIT']) {
  test(`${name} rejects every non-string, blank, and unknown stamp`, () => {
    for (const value of invalidStamps) {
      const result = audit(withStamp(name, value));
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}`);
      assert.match(result.stderr, new RegExp(`missing or unknown build ${name.endsWith('VERSION') ? 'version' : 'commit'}`));
      assert.doesNotMatch(result.stderr, new RegExp(`missing or unknown build ${name.endsWith('VERSION') ? 'commit' : 'version'}`));
    }
  });

  test(`${name} failure leaves the other stamp valid`, () => {
    const result = audit(withStamp(name, 'unknown'));
    assert.notEqual(result.status, 0);
    const otherName = name.endsWith('VERSION') ? 'commit' : 'version';
    assert.doesNotMatch(result.stderr, new RegExp(`missing or unknown build ${otherName}`));
  });
}

test('accepts non-empty strings with external whitespace without requiring a format', () => {
  const result = audit(withStamp('MYRMIDON_BUILD_VERSION', '  release-name  '));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: boot contract/);

  const both = structuredClone(valid);
  both.env.MYRMIDON_BUILD_VERSION = '\tversion-anything\n';
  both.env.MYRMIDON_BUILD_COMMIT = ' commit-without-sha40 ';
  const bothResult = audit(both);
  assert.equal(bothResult.status, 0, bothResult.stderr);
  assert.match(bothResult.stdout, /PASS: boot contract/);
});
