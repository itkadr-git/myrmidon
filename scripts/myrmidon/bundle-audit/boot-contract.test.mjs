import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./boot-contract.mjs', import.meta.url));
const good = () => ({ argv: ['node', 'server/dist/index.js'], env: { MYRMIDON_BUILD_VERSION: '1.7.0', MYRMIDON_BUILD_COMMIT: 'abc123' } });
function audit(manifest) {
  return spawnSync(process.execPath, [cli], { input: typeof manifest === 'string' ? manifest : JSON.stringify(manifest), encoding: 'utf8', env: { PATH: process.env.PATH } });
}

test('accepts bare node and retains a permitted memory option', () => {
  const m = good(); m.env.NODE_OPTIONS = '--max-old-space-size=2048';
  const result = audit(m);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--max-old-space-size=2048/);
});

test('never executes shell-like input', () => {
  const marker = join(tmpdir(), `boot-contract-${process.pid}`);
  const m = good(); m.argv = `node server/dist/index.js; touch ${marker}`;
  assert.notEqual(audit(m).status, 0);
  assert.equal(existsSync(marker), false);
});

test('reports split and equals loader and import flags in argv', () => {
  for (const option of [['--loader', 'tsx'], ['--loader=tsx'], ['--import', 'tsx'], ['--import=tsx'], ['--experimental-loader=x']]) {
    const m = good(); m.argv = ['node', ...option, 'server/dist/index.js'];
    const result = audit(m);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /loader|import/i);
  }
});

test('rejects NODE_OPTIONS bypasses, including quoted and underscore flags', () => {
  for (const option of ['--loader tsx', '--import=tsx', '"--experimental-loader=x"', '--experimental_loader=x', '--require ts-node/register']) {
    const m = good(); m.env.NODE_OPTIONS = option;
    const result = audit(m);
    assert.notEqual(result.status, 0, option); assert.match(result.stderr, /NODE_OPTIONS/);
  }
});

test('reports all missing stamps and invalid command', () => {
  const result = audit({ argv: ['sh', '-c', 'node server/dist/index.js'], env: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /argv/); assert.match(result.stderr, /version/i); assert.match(result.stderr, /commit/i);
});

test('rejects unknown stamps, malformed manifests and malformed options', () => {
  for (const m of ['not json', {}, { ...good(), env: { MYRMIDON_BUILD_VERSION: 'unknown', MYRMIDON_BUILD_COMMIT: 'abc' } }, { ...good(), env: { ...good().env, NODE_OPTIONS: '"--import=x' } }]) {
    assert.notEqual(audit(m).status, 0);
  }
});

test('requires both Myrmidon build stamps', () => {
  for (const name of ['MYRMIDON_BUILD_VERSION', 'MYRMIDON_BUILD_COMMIT']) {
    const m = good(); delete m.env[name];
    const result = audit(m);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing or unknown build/);
  }
});
