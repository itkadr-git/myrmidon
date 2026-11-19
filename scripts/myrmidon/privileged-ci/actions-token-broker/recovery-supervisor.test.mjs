import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoverySupervisor } from './recovery-supervisor.mjs';

test('recovery supervisor retries while issuance stays stopped, then starts exactly once', async () => {
  let attempts = 0, starts = 0;
  const alerts = [];
  const supervisor = createRecoverySupervisor({
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

test('ambiguous issuance remains stopped even when alert delivery fails', async () => {
  let attempts = 0, starts = 0;
  const supervisor = createRecoverySupervisor({
    recover: async () => { attempts++; return { failed: 0, pending: true, alertFailed: false }; },
    start: async () => { starts++; },
    alert: async () => { throw new Error('unavailable'); },
    delay: async () => { supervisor.stop(); },
  });
  await assert.rejects(supervisor.run(), /stopped/);
  assert.equal(attempts, 1);
  assert.equal(starts, 0);
});
