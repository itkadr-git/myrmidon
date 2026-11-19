import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createRecoveryWorker } from './recovery-worker.mjs';

test('anchored pending intent retries ambiguous alert after outbox failure even without local reservation', async () => {
  let queues = 0;
  const alerts = [];
  const store = {
    revokeRetained: async () => ({ revoked: 0, failed: 0 }),
    pendingIssuances: async () => [],
    queueAlert: async () => { queues++; throw new Error('outbox offline'); },
    pendingAlertEntries: async () => [], pendingAlerts: async () => [],
  };
  const worker = createRecoveryWorker({ store, anchoredPending: true, revoke: async () => {}, alert: async event => alerts.push(event) });
  const first = await worker.runOnce();
  const second = await worker.runOnce();
  assert.equal(first.pending, true);
  assert.equal(second.alertFailed, true);
  assert.equal(queues, 2);
  assert.deepEqual(alerts, ['issuance_ambiguous', 'credential_recovery_failed', 'issuance_ambiguous', 'credential_recovery_failed']);
});

test('credential enumeration failure alerts and permits a later recovery pass', async () => {
  let attempts = 0;
  const alerts = [];
  const store = {
    revokeRetained: async () => { if (++attempts === 1) throw new Error('credential storage unavailable'); return { revoked: 1, failed: 0 }; },
    pendingIssuances: async () => [], queueAlert: async () => {},
    pendingAlertEntries: async () => [], pendingAlerts: async () => [],
  };
  const worker = createRecoveryWorker({ store, revoke: async () => {}, alert: async event => alerts.push(event) });
  const first = await worker.runOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.alertFailed, true);
  assert.ok(alerts.includes('credential_recovery_failed'));
  assert.equal((await worker.runOnce()).revoked, 1);
});

test('pending reservation read failure keeps known-token recovery retryable', async () => {
  let attempts = 0;
  const alerts = [];
  const store = {
    revokeRetained: async () => ({ revoked: attempts++ ? 1 : 0, failed: attempts === 1 ? 1 : 0 }),
    pendingIssuances: async () => { throw new Error('reservation storage unavailable'); },
    queueAlert: async () => {}, pendingAlertEntries: async () => [], pendingAlerts: async () => [],
  };
  const worker = createRecoveryWorker({ store, revoke: async () => {}, alert: async event => alerts.push(event) });
  const first = await worker.runOnce();
  const second = await worker.runOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.alertFailed, true);
  assert.equal(second.revoked, 1);
  assert.equal(second.alertFailed, true);
  assert.ok(alerts.includes('credential_recovery_failed'));
});

test('outbox failure does not prevent recovery retry of a known credential', async () => {
  let revokes = 0;
  const alerts = [];
  const store = {
    revokeRetained: async () => ({ revoked: revokes++ ? 1 : 0, failed: revokes === 1 ? 1 : 0 }),
    pendingIssuances: async () => ['unknown'],
    queueAlert: async () => { throw new Error('outbox offline'); },
    pendingAlertEntries: async () => [], pendingAlerts: async () => [],
  };
  const worker = createRecoveryWorker({ store, revoke: async () => {}, alert: async event => alerts.push(event) });
  const first = await worker.runOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.alertFailed, true);
  const second = await worker.runOnce();
  assert.equal(second.revoked, 1);
  assert.equal(second.pending, true);
  assert.equal(second.alertFailed, true);
  assert.ok(alerts.includes('issuance_ambiguous'));
  assert.ok(alerts.includes('credential_recovery_failed'));
});

test('an alert queued during delivery remains pending after the earlier alert is acknowledged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-alert-race-'));
  const store = createCredentialStore(join(dir, 'credentials.sqlite'), randomBytes(32));
  try {
    await store.queueAlert('audit_unavailable');
    const worker = createRecoveryWorker({
      store, revoke: async () => {},
      alert: async () => { await store.queueAlert('audit_unavailable'); },
    });
    await worker.runOnce();
    assert.deepEqual(await store.pendingAlerts(), ['audit_unavailable']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('recovery reports a missing retained token as failure and continues with other credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-corrupt-'));
  const path = join(dir, 'credentials.sqlite'), key = randomBytes(32);
  const store = createCredentialStore(path, key);
  try {
    await store.put('bad', { other: 'invalid' }, 'owner');
    await store.put('good', { token: 'valid-fixture' }, 'owner');
    const revoked = [], alerts = [];
    const worker = createRecoveryWorker({ store, revoke: async token => revoked.push(token), alert: async event => alerts.push(event) });
    const result = await worker.runOnce();
    assert.equal(result.failed, 1);
    assert.deepEqual(revoked, ['valid-fixture']);
    assert.ok(alerts.includes('credential_recovery_failed'));
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM credentials').get().n, 1); } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

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
    const worker = createRecoveryWorker({ store, revoke: async () => { if (++revokes === 1) throw new Error('unavailable'); }, alert: async event => { alerts++; if (event === 'issuance_ambiguous') throw new Error('unavailable'); } });
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
