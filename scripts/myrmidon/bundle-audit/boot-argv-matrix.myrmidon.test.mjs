import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const stamps = {
  MYRMIDON_BUILD_VERSION: '1.7.0',
  MYRMIDON_BUILD_COMMIT: 'abc123',
};

function manifest(argv) {
  return { argv, env: { ...stamps } };
}

function audit(argv) {
  return spawnSync(process.execPath, [cli], {
    input: JSON.stringify(manifest(argv)),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
}

function assertRejected(argv, category) {
  const original = [...argv];
  const result = audit(argv);
  assert.equal(result.status, 1, `expected rejection for ${JSON.stringify(argv)}: ${result.error || result.stderr}`);
  assert.deepEqual(argv, original);
  assert.match(result.stderr, new RegExp(category, 'i'), result.stderr);
  assert.equal(result.stdout, '', 'rejected input must not produce a PASS report');
}

function assertAccepted() {
  const result = audit(['node', 'server/dist/index.js']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: boot contract/);
  assert.equal(result.stderr, '');
}

test('accepts only the exact dist boot argv', () => {
  assertAccepted();

  for (const argv of [
    ['/usr/bin/node', 'server/dist/index.js'],
    ['node', './server/dist/index.js'],
    ['sh', '-c', 'node server/dist/index.js'],
    ['node', 'server/dist/index.js', '--inspect'],
    ['node', 'server/dist/index.js', 'extra-argument'],
  ]) {
    assertRejected(argv, 'argv');
  }

  assertAccepted();
});

test('classifies loader and import runtime options in argv', () => {
  assertAccepted();

  for (const [option, category] of [
    ['--LOADER=custom-loader', 'runtime option: loader'],
    ['--experimental_loader=custom-loader', 'runtime option: loader'],
    ['--IMPORT=custom-import', 'runtime option: import'],
  ]) {
    assertRejected(['node', option, 'server/dist/index.js'], category);
  }

  assertAccepted();
});

test('classifies TypeScript runtimes in slash, backslash, and scoped paths', () => {
  assertAccepted();

  for (const runtime of [
    'tools/tsx',
    'tools\\tsx',
    '@scope/tsx',
    'tools/ts-node/register',
    'tools\\ts-node\\register',
    '@scope/ts-node/register',
  ]) {
    assertRejected(['node', runtime, 'server/dist/index.js'], 'TypeScript runtime');
  }

  assertAccepted();
});
