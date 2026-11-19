import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoverySupervisor } from './recovery-supervisor.mjs';
import { createCredentialStore } from './store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function memoryOutbox() {
  const pending = new Map();
  return { queueAlert: async event => pending.set(event, randomBytes(16).toString('hex')), pendingAlerts: async () => [...pending.keys()], pendingAlertEntries: async () => [...pending].map(([event, generation]) => ({ event, generation })), acknowledgeAlert: async (event, generation) => { if (pending.get(event) === generation) pending.delete(event); } };
}

test('a supervisor cannot start issuance twice after successful recovery', async () => {
  let starts = 0;
  const supervisor = createRecoverySupervisor({
    store: memoryOutbox(), recover: async () => ({ failed: 0, pending: false, alertFailed: false }),
    alert: async () => {}, start: async () => { starts++; }, delay: async () => {},
  });
  await supervisor.run();
  await assert.rejects(supervisor.run());
  assert.equal(starts, 1);
});

test('failed recovery alert survives a supervisor and store restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-outbox-'));
  const path = join(dir, 'store.sqlite'), key = randomBytes(32);
  let store = createCredentialStore(path, key), started = 0;
  try {
    const first = createRecoverySupervisor({ store, recover: async () => ({ failed: 1, pending: false, alertFailed: false }), alert: async () => { throw new Error('offline'); }, start: async () => { started++; }, delay: async () => first.stop() });
    await assert.rejects(first.run(), /stopped/);
    store.close();
    store = createCredentialStore(path, key);
    const delivered = [];
    const second = createRecoverySupervisor({ store, recover: async () => ({ failed: 0, pending: false, alertFailed: false }), alert: async event => delivered.push(event), start: async () => { started++; }, delay: async () => {} });
    await second.run();
    assert.deepEqual(delivered, ['credential_recovery_failed']);
    assert.equal(started, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('shutdown during failed recovery persists the alert for the next supervisor', async () => {
  const store = memoryOutbox();
  const first = createRecoverySupervisor({
    store,
    recover: async () => { first.stop(); return { failed: 1, pending: false, alertFailed: false }; },
    alert: async () => {}, start: async () => {}, delay: async () => {},
  });
  await assert.rejects(first.run(), /stopped/);
  const delivered = [];
  const second = createRecoverySupervisor({
    store, recover: async () => ({ failed: 0, pending: false, alertFailed: false }),
    alert: async event => delivered.push(event), start: async () => {}, delay: async () => {},
  });
  await second.run();
  assert.deepEqual(delivered, ['credential_recovery_failed']);
});

test('shutdown during alert delivery prevents issuance from starting', async () => {
  const store = memoryOutbox();
  await store.queueAlert('credential_recovery_failed');
  let starts = 0;
  const supervisor = createRecoverySupervisor({
    store, recover: async () => ({ failed: 0, pending: false, alertFailed: false }),
    alert: async () => supervisor.stop(), start: async () => { starts++; }, delay: async () => {},
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.equal(starts, 0);
});

test('simultaneous ambiguous issuance and failed revocation both survive restart', async () => {
  const store = memoryOutbox();
  const first = createRecoverySupervisor({
    store, recover: async () => ({ failed: 1, pending: true, alertFailed: false }),
    alert: async () => { throw new Error('offline'); }, start: async () => assert.fail('must stay stopped'),
    delay: async () => first.stop(),
  });
  await assert.rejects(first.run(), /stopped/);
  assert.deepEqual((await store.pendingAlerts()).sort(), ['credential_recovery_failed', 'issuance_ambiguous']);
});

test('recovery supervisor retries while issuance stays stopped, then starts exactly once', async () => {
  let attempts = 0, starts = 0;
  const alerts = [];
  const supervisor = createRecoverySupervisor({
    store: memoryOutbox(),
    recover: async () => ++attempts === 1 ? { failed: 1, pending: false, alertFailed: false } : { failed: 0, pending: false, alertFailed: false },
    start: async () => { starts++; return 'server'; },
    alert: async event => { alerts.push(event); },
    delay: async () => {},
  });
  assert.equal(await supervisor.run(), 'server');
  assert.equal(attempts, 2);
  assert.equal(starts, 1);
  assert.deepEqual(alerts, ['credential_recovery_failed']);
});

test('outbox failure does not prevent retrying known-token recovery', async () => {
  let attempts = 0, starts = 0;
  const alerts = [];
  const store = { ...memoryOutbox(), queueAlert: async () => { throw new Error('disk offline'); } };
  const supervisor = createRecoverySupervisor({
    store,
    recover: async () => ({ failed: ++attempts === 1 ? 1 : 0, pending: true, alertFailed: false }),
    alert: async event => alerts.push(event), start: async () => { starts++; },
    delay: async () => { if (attempts === 2) supervisor.stop(); },
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.equal(attempts, 2);
  assert.equal(starts, 0);
  assert.ok(alerts.includes('credential_recovery_failed'));
});

test('outbox read failure does not interrupt known-token recovery retries', async () => {
  let attempts = 0, starts = 0;
  const store = { ...memoryOutbox(), pendingAlertEntries: async () => { throw new Error('disk offline'); } };
  const supervisor = createRecoverySupervisor({
    store, recover: async () => ({ failed: ++attempts === 1 ? 1 : 0, pending: true, alertFailed: false }),
    alert: async () => {}, start: async () => { starts++; },
    delay: async () => { if (attempts === 2) supervisor.stop(); },
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.equal(attempts, 2);
  assert.equal(starts, 0);
});

test('a failed alert must be delivered before a later clean recovery can start issuance', async () => {
  let attempts = 0, deliveries = 0, starts = 0;
  const supervisor = createRecoverySupervisor({
    store: memoryOutbox(),
    recover: async () => ++attempts === 1 ? { failed: 1, pending: false, alertFailed: false } : { failed: 0, pending: false, alertFailed: false },
    alert: async () => { if (++deliveries === 1) throw new Error('unavailable'); },
    start: async () => { starts++; },
    delay: async () => {},
  });
  await supervisor.run();
  assert.equal(deliveries, 2);
  assert.equal(starts, 1);
});

test('outbox failure attempts an independent alert and never starts issuance', async () => {
  let starts = 0;
  const alerts = [];
  const store = { ...memoryOutbox(), queueAlert: async () => { throw new Error('disk offline'); } };
  const supervisor = createRecoverySupervisor({
    store, recover: async () => ({ failed: 1, pending: true, alertFailed: false }),
    alert: async event => alerts.push(event), start: async () => { starts++; }, delay: async () => supervisor.stop(),
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.deepEqual(alerts, ['issuance_ambiguous', 'credential_recovery_failed']);
  assert.equal(starts, 0);
});

test('outbox failure during shutdown still attempts an independent alert', async () => {
  const alerts = [];
  const store = { ...memoryOutbox(), queueAlert: async () => { throw new Error('disk offline'); } };
  const supervisor = createRecoverySupervisor({
    store, recover: async () => { supervisor.stop(); return { failed: 1, pending: true, alertFailed: false }; },
    alert: async event => alerts.push(event), start: async () => assert.fail('must stay stopped'), delay: async () => {},
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.deepEqual(alerts, ['issuance_ambiguous', 'credential_recovery_failed']);
});

test('ambiguous issuance remains stopped even when alert delivery fails', async () => {
  let attempts = 0, starts = 0;
  const supervisor = createRecoverySupervisor({
    store: memoryOutbox(),
    recover: async () => { attempts++; return { failed: 0, pending: true, alertFailed: false }; },
    start: async () => { starts++; },
    alert: async () => { throw new Error('unavailable'); },
    delay: async () => { supervisor.stop(); },
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.equal(attempts, 1);
  assert.equal(starts, 0);
});
