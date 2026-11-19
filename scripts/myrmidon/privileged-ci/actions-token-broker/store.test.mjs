import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCredentialStore } from './store.mjs';

test('operator recovery retries retained credentials after restart without exposing tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-recovery-'));
  const path = join(dir, 'credentials.sqlite');
  const key = randomBytes(32);
  try {
    let store = createCredentialStore(path, key);
    await store.put('one', { token: 'fixture-one' }, 'owner-one');
    await store.put('two', { token: 'fixture-two' }, 'owner-two');
    store.close();
    store = createCredentialStore(path, key);
    const attempts = [];
    const first = await store.revokeRetained(async token => {
      attempts.push(token);
      if (token === 'fixture-two') throw new Error('upstream failed');
    });
    assert.deepEqual(first, { revoked: 1, failed: 1 });
    store.close();
    store = createCredentialStore(path, key);
    const second = await store.revokeRetained(async token => { attempts.push(token); });
    assert.deepEqual(second, { revoked: 1, failed: 0 });
    assert.deepEqual(attempts, ['fixture-one', 'fixture-two', 'fixture-two']);
    assert.deepEqual(await store.revokeRetained(async () => assert.fail()), { revoked: 0, failed: 0 });
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('encrypted credentials persist across restart, enforce ownership and retain failed revocations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-store-'));
  const path = join(dir, 'credentials.sqlite');
  const key = randomBytes(32);
  const credential = { token: 'fixture-sensitive-value', expiresAt: '2030-01-01T00:00:00Z' };
  try {
    let store = createCredentialStore(path, key);
    await store.put('handle', credential, 'owner');
    store.close();
    assert.equal(readFileSync(path).includes(Buffer.from(credential.token)), false);
    store = createCredentialStore(path, key);
    await assert.rejects(store.withOwned('handle', 'other', async () => {}));
    await assert.rejects(store.withOwned('handle', 'owner', async () => { throw new Error('upstream failed'); }));
    let recovered;
    await store.withOwned('handle', 'owner', async value => { recovered = value; });
    assert.deepEqual(recovered, credential);
    await assert.rejects(store.withOwned('handle', 'owner', async () => {}));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
