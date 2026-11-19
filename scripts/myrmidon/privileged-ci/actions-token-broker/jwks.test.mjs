import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGitHubKeys } from './jwks.mjs';

test('loads only the fixed GitHub JWKS endpoint and rejects failures and redirects', async () => {
  let call;
  const keys = [{ kid: 'fixture' }];
  assert.deepEqual(await loadGitHubKeys(async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, json: async () => ({ keys }) };
  }), keys);
  assert.equal(call.url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
  assert.equal(call.options.redirect, 'error');
  for (const response of [
    { ok: false, status: 302 },
    { ok: false, status: 500 },
    { ok: true, status: 200, json: async () => ({ keys: 'not an array' }) },
  ]) await assert.rejects(loadGitHubKeys(async () => response));
  await assert.rejects(loadGitHubKeys(async () => { throw new Error('network failure'); }));
});

test('rejects and cancels an oversized streamed JWKS response', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(loadGitHubKeys(async () => ({
    ok: true, status: 200, body,
    json: async () => ({ keys: [] }),
  })), /JWKS/);
  assert.equal(cancelled, true);
});
