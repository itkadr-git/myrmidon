import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createCredentialCheckpoint, checkpointCredentialStore } from './credential-checkpoint.mjs';
import { createAuditedSupervisedServer } from './tls.mjs';

test('lost checkpoint acknowledgement after recovery leaves restart fenced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-lost-checkpoint-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  let head = { seq: 0, mac: '' }, failNext = false;
  const credentialAnchor = {
    read: async () => ({ ...head }),
    compareAndSet: async (previous, next) => {
      if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
      head = { ...next };
      if (failNext) { failNext = false; throw new Error('checkpoint response lost'); }
      return true;
    },
  };
  const alerts = [], revoked = [];
  try {
    let store = createCredentialStore(credentialPath, credentialKey);
    const checkpoint = await createCredentialCheckpoint(store, credentialAnchor, { provision: true });
    await checkpointCredentialStore(store, checkpoint).put('known', { token: 'fixture-known' }, 'owner');
    store.close();
    failNext = true;
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey, credentialAnchor,
      installation: { revoke: async token => revoked.push(token) }, alert: async event => alerts.push(event),
    }), /audit offline/);
    assert.deepEqual(revoked, []);
    assert.ok(alerts.includes('credential_recovery_failed'));
    store = createCredentialStore(credentialPath, credentialKey);
    try {
      assert.equal(store.hasRetainedCredentials(), true);
      await assert.rejects(createCredentialCheckpoint(store, credentialAnchor), /checkpoint mismatch/);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
