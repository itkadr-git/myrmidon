import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createRecoveryWorker } from './recovery-worker.mjs';

test('worker retries revocation and pending alert after restart without clearing unknown issuance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-worker-'));
  const path = join(dir, 'credentials.sqlite'), key = randomBytes(32);
  try {
    let store = createCredentialStore(path, key);
    await store.reserveIssuance('unknown');
    await store.put('retained', { token: 'fixture' }, 'owner');
    store.close();
    store = createCredentialStore(path, key);
    let revokes = 0, alerts = 0;
    const worker = createRecoveryWorker({ store, revoke: async () => { if (++revokes === 1) throw new Error('unavailable'); }, alert: async () => { if (++alerts === 1) throw new Error('unavailable'); } });
    const first = await worker.runOnce();
    assert.equal(first.failed, 1);
    assert.equal(first.alertFailed, true);
    assert.deepEqual(await store.pendingAlerts(), ['issuance_ambiguous']);
    store.close();
    store = createCredentialStore(path, key);
    const next = createRecoveryWorker({ store, revoke: async () => { revokes++; }, alert: async () => { alerts++; } });
    const second = await next.runOnce();
    assert.equal(second.revoked, 1);
    assert.equal(second.pending, true);
    assert.equal(second.alertFailed, false);
    assert.deepEqual(await store.pendingIssuances(), ['unknown']);
    assert.equal(revokes, 2);
    assert.ok(alerts >= 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
