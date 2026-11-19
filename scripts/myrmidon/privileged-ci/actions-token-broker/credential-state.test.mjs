import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';

test('credential state digest changes on issuance and detects restoring an older database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-state-'));
  const path = join(dir, 'credentials.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const key = randomBytes(32);
  try {
    let store = createCredentialStore(path, key);
    const empty = store.stateDigest();
    store.close();
    copyFileSync(path, snapshot);
    store = createCredentialStore(path, key);
    await store.reserveIssuance('attempt');
    await store.put('handle', { token: 'fixture-value' }, 'owner');
    await store.resolveIssuance('attempt');
    const issued = store.stateDigest();
    assert.match(issued, /^[0-9a-f]{64}$/);
    assert.notEqual(issued, empty);
    store.close();
    store = createCredentialStore(path, key);
    assert.equal(store.stateDigest(), issued);
    store.close();
    copyFileSync(snapshot, path);
    store = createCredentialStore(path, key);
    assert.equal(store.stateDigest(), empty);
    assert.notEqual(store.stateDigest(), issued);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
