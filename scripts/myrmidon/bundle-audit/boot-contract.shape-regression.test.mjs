import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const fixture = () => ({
  argv: ['node', 'server/dist/index.js'],
  env: { MYRMIDON_BUILD_VERSION: '1.7.0', MYRMIDON_BUILD_COMMIT: 'abc123' },
});

function check(manifest, expectedStatus) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'boot-shape-'));
  try {
    const sentinel = join(dir, 'executed');
    const input = join(dir, 'manifest.json');
    const original = JSON.stringify(manifest(sentinel));
    writeFileSync(input, original);
    const result = spawnSync(process.execPath, [cli], {
      input: readFileSync(input), encoding: 'utf8', cwd: dir,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(readFileSync(input, 'utf8'), original, 'input file must not change');
    assert.equal(existsSync(sentinel), false, 'manifest data must not execute');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('rejects non-object manifest shapes', () => {
  for (const value of [null, [], 'text', 42, true]) check(() => value, 1);
});

test('requires exactly two string argv elements', () => {
  for (const argv of ['node server/dist/index.js', ['node', 'server/dist/index.js', 'extra'], ['node', 42], ['node'], ['node', 'other.js']]) {
    check(() => ({ ...fixture(), argv }), 1);
  }
  check((sentinel) => ({ ...fixture(), argv: `node server/dist/index.js; touch ${sentinel}` }), 1);
});

test('requires an object of strings and both known build stamps', () => {
  for (const env of [null, [], 42, { ...fixture().env, PORT: 3100 },
    { MYRMIDON_BUILD_VERSION: '1.7.0' }, { MYRMIDON_BUILD_COMMIT: 'abc123' },
    { ...fixture().env, MYRMIDON_BUILD_VERSION: 'unknown' },
    { ...fixture().env, MYRMIDON_BUILD_COMMIT: 'unknown' }]) {
    check(() => ({ ...fixture(), env }), 1);
  }
});

test('accepts a valid manifest and treats shell tokens in env as literal data', () => {
  check((sentinel) => ({ ...fixture(), env: { ...fixture().env, LITERAL: `$(touch ${sentinel}); touch ${sentinel}` } }), 0);
});
