import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore } from './store.mjs';
import { createCredentialCheckpoint, checkpointCredentialStore } from './credential-checkpoint.mjs';
import { createAuditedSupervisedServer } from './tls.mjs';

test('audit outage recovery preserves credential checkpoint across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-checkpoint-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const credentialAnchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  const revoked = [];
  try {
    let store = createCredentialStore(credentialPath, credentialKey);
    const checkpoint = await createCredentialCheckpoint(store, credentialAnchor, { provision: true });
    await checkpointCredentialStore(store, checkpoint).put('known', { token: 'fixture-known' }, 'owner');
    store.close();
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey, credentialAnchor,
      installation: { revoke: async token => revoked.push(token) }, alert: async () => {},
    }), /audit offline/);
    assert.deepEqual(revoked, ['fixture-known']);
    store = createCredentialStore(credentialPath, credentialKey);
    try {
      await createCredentialCheckpoint(store, credentialAnchor);
      assert.equal(store.hasRetainedCredentials(), false);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit outage retries failed revocation and preserves checkpoint after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-retry-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  let head = { seq: 0, mac: '' }, attempts = 0, delays = 0;
  const credentialAnchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  const alerts = [];
  try {
    let store = createCredentialStore(credentialPath, credentialKey);
    const checkpoint = await createCredentialCheckpoint(store, credentialAnchor, { provision: true });
    await checkpointCredentialStore(store, checkpoint).put('known', { token: 'fixture-known' }, 'owner');
    store.close();
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey, credentialAnchor,
      installation: { revoke: async token => {
        assert.equal(token, 'fixture-known');
        if (++attempts === 1) throw new Error('revoke unavailable');
      } },
      alert: async event => alerts.push(event), delay: async () => { delays++; },
    }), /audit offline/);
    assert.equal(attempts, 2);
    assert.equal(delays, 1);
    assert.ok(alerts.includes('credential_recovery_failed'));
    store = createCredentialStore(credentialPath, credentialKey);
    try {
      await createCredentialCheckpoint(store, credentialAnchor);
      assert.equal(store.hasRetainedCredentials(), false);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lost revocation response remains fenced when later retries are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-lost-revoke-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  let head = { seq: 0, mac: '' }, attempts = 0, delays = 0;
  const credentialAnchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  const alerts = [];
  try {
    let store = createCredentialStore(credentialPath, credentialKey);
    const checkpoint = await createCredentialCheckpoint(store, credentialAnchor, { provision: true });
    await checkpointCredentialStore(store, checkpoint).put('known', { token: 'fixture-known' }, 'owner');
    store.close();
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey, credentialAnchor, alert: async event => alerts.push(event),
      installation: { revoke: async token => {
        assert.equal(token, 'fixture-known');
        if (++attempts === 1) throw new Error('revocation response lost');
        throw new Error('upstream rejects the now-invalid token');
      } },
      delay: async () => { if (++delays === 2) throw new Error('stop fixture'); },
    }), /audit offline/);
    assert.equal(attempts, 2);
    assert.equal(delays, 2);
    assert.ok(alerts.includes('credential_recovery_failed'));
    store = createCredentialStore(credentialPath, credentialKey);
    try {
      await createCredentialCheckpoint(store, credentialAnchor);
      assert.equal(store.hasRetainedCredentials(), true);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit outage without credential anchor never recovers unverified credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-no-anchor-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const alerts = [], revoked = [];
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('untrusted', { token: 'fixture' }, 'owner');
    store.close();
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey,
      installation: { revoke: async token => revoked.push(token) }, alert: async event => alerts.push(event),
    }), /audit offline/);
    assert.deepEqual(revoked, []);
    assert.ok(alerts.includes('credential_recovery_failed'));
    const reopened = createCredentialStore(credentialPath, credentialKey);
    try { assert.equal(reopened.hasRetainedCredentials(), true); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit outage and credential checkpoint mismatch never revoke untrusted restored state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-recovery-mismatch-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const credentialAnchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => {
    if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  const alerts = [], revoked = [];
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await createCredentialCheckpoint(store, credentialAnchor, { provision: true });
    await store.put('untrusted', { token: 'fixture' }, 'owner');
    store.close();
    await assert.rejects(createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('audit offline'); }, compareAndSet: async () => false },
      credentialPath, credentialKey, credentialAnchor,
      installation: { revoke: async token => revoked.push(token) }, alert: async event => alerts.push(event),
    }), /audit offline/);
    assert.deepEqual(revoked, []);
    assert.ok(alerts.includes('credential_recovery_failed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
