import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createBroker, createSingleHostBroker, createRecoveredSingleHostBroker, createSupervisedSingleHostBroker } from './broker.mjs';
import * as tls from './tls.mjs';
const { createRecoveredSecureServer } = tls;
import { createCredentialStore } from './store.mjs';
import { createInstallationClient } from './installation.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const policy = { audience: 'isolated', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push', sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
function jwt(jti, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, ...policy, run_id: '100', run_attempt: '1', jti, ...overrides };
  const input = [ { alg: 'RS256', kid: 'fixture' }, claims ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

test('invalid upstream scope and failed revocation retain the known token for restart recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-rejected-retain-'));
  const revoked = [];
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const installation = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture', request: async (_url, options) => {
    if (options.method === 'DELETE') return { ok: false };
    return { ok: true, json: async () => ({ token: 'fixture-known', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' }, repositories: [{ id: 123 }] }) };
  } });
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath, credentialKey, installation, audit: async () => {} };
  try {
    const broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('rejected-scope')));
    broker.close();
    const store = createCredentialStore(credentialPath, credentialKey);
    try {
      const result = await store.revokeRetained(async token => revoked.push(token));
      assert.equal(result.revoked, 1);
      assert.deepEqual(revoked, ['fixture-known']);
      assert.equal((await store.pendingIssuances()).length, 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audited TLS lifecycle retries recovery before constructing a server', async () => {
  assert.equal(typeof tls.createAuditedSupervisedServer, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'broker-supervised-tls-'));
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => { throw new Error('offline'); } }, audit: async () => {} };
  let delays = 0;
  try {
    const initial = createSingleHostBroker(options);
    await initial.exchange(jwt('tls-supervisor-initial'));
    initial.close();
    const anchor = { read: () => ({ seq: 0, mac: '' }), compareAndSet: () => true };
    await assert.rejects(tls.createAuditedSupervisedServer({}, { ...options, auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32), auditAnchor: anchor, alert: async () => {}, delay: async () => { delays++; throw new Error('retry observed'); } }), /retry observed/);
    assert.equal(delays, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supervised broker retries recovery while retaining exclusive ownership before serving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-supervised-'));
  let revokes = 0, delays = 0;
  const alerts = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => { if (++revokes === 1) throw new Error('offline'); } }, audit: async () => {}, alert: async event => alerts.push(event) };
  try {
    const initial = createSingleHostBroker(options);
    await initial.exchange(jwt('supervisor-initial'));
    initial.close();
    const recovered = await createSupervisedSingleHostBroker({ ...options, delay: async () => {
      delays++;
      assert.throws(() => createSingleHostBroker(options), /exclusive/);
    } });
    try {
      assert.equal(revokes, 2);
      assert.equal(delays, 1);
      assert.deepEqual(alerts, ['credential_recovery_failed']);
      await recovered.exchange(jwt('supervisor-recovered'));
    } finally { recovered.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery refuses to revoke credentials while another broker owns the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-exclusive-'));
  let revokes = 0;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => { revokes++; } }, audit: async () => {} };
  try {
    const broker = createSingleHostBroker(options);
    try {
      await broker.exchange(jwt('exclusive-active'));
      await assert.rejects(createRecoveredSingleHostBroker(options), /exclusive/);
      assert.equal(revokes, 0);
    } finally { broker.close(); }
    const recovered = await createRecoveredSingleHostBroker(options);
    recovered.close();
    assert.equal(revokes, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lost issuance response blocks further issuance across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-ambiguous-'));
  const credentialKey = randomBytes(32);
  let calls = 0;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey, installation: { issue: async () => { calls++; throw new Error('response lost after create'); }, revoke: async () => {} }, audit: async () => {} };
  try {
    let broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('lost-response')));
    broker.close();
    broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('after-restart')));
    broker.close();
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed audit and failed revoke retain the issuance lock across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-audit-revoke-'));
  let issued = 0;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { issued++; return { token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; }, revoke: async () => { throw new Error('unavailable'); } }, audit: async () => { throw new Error('audit unavailable'); } };
  try {
    let broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('audit-revoke-first')));
    broker.close();
    broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('audit-revoke-second')));
    broker.close();
    assert.equal(issued, 1);
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    assert.equal((await store.pendingIssuances()).length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ambiguous issuance emits a distinct alert event while reservation remains pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-alert-'));
  const events = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { throw new Error('response lost'); }, revoke: async () => assert.fail('unknown token cannot be revoked') }, audit: async event => events.push(event) };
  try {
    const broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('alert-lost')));
    broker.close();
    assert.ok(events.includes('issuance_ambiguous'));
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    assert.equal((await store.pendingIssuances()).length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ambiguous issuance immediately alerts without releasing the durable reservation if alert delivery fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-immediate-alert-'));
  const alerts = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { throw new Error('lost response'); }, revoke: async () => assert.fail('unknown token') }, audit: async () => {}, alert: async event => { alerts.push(event); throw new Error('alert unavailable'); } };
  try {
    const broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('immediate-alert')));
    broker.close();
    assert.deepEqual(alerts, ['issuance_ambiguous']);
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    assert.equal((await store.pendingIssuances()).length, 1);
    assert.deepEqual(await store.pendingAlerts(), ['issuance_ambiguous']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery alerts on pending ambiguous issuance after restart and keeps issuance blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-recovery-alert-'));
  const alerts = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { throw new Error('response lost'); }, revoke: async () => assert.fail('unknown token cannot be revoked') }, audit: async () => {}, alert: async event => alerts.push(event) };
  try {
    const broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('recovery-alert')));
    broker.close();
    assert.deepEqual(alerts, ['issuance_ambiguous']);
    alerts.length = 0;
    await assert.rejects(createRecoveredSingleHostBroker(options), /ambiguous issuance/);
    assert.deepEqual(alerts, ['issuance_ambiguous']);
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    assert.equal((await store.pendingIssuances()).length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovered broker refuses startup until a persisted alert is delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-recovery-outbox-'));
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { revoke: async () => {} }, audit: async () => {}, alert: async () => { throw new Error('offline'); } };
  try {
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    await store.queueAlert('issuance_ambiguous');
    store.close();
    await assert.rejects(createRecoveredSingleHostBroker(options), /alert/);
    const delivered = [];
    const broker = await createRecoveredSingleHostBroker({ ...options, alert: async event => delivered.push(event) });
    broker.close();
    assert.deepEqual(delivered, ['issuance_ambiguous']);
    const reopened = createCredentialStore(options.credentialPath, options.credentialKey);
    assert.deepEqual(await reopened.pendingAlerts(), []);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery alerts about pending issuance even when retained revocation fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-recovery-both-'));
  const alerts = [];
  const credentialPath = join(dir, 'credentials.sqlite');
  const credentialKey = randomBytes(32);
  const options = { credentialPath, credentialKey, installation: { revoke: async () => { throw new Error('unavailable'); } }, alert: async event => alerts.push(event) };
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('retained', { token: 'fixture' }, 'owner');
    await store.reserveIssuance('unknown');
    store.close();
    await assert.rejects(createRecoveredSingleHostBroker(options));
    assert.deepEqual(alerts.sort(), ['credential_recovery_failed', 'issuance_ambiguous']);
    const reopened = createCredentialStore(credentialPath, credentialKey);
    assert.deepEqual(await reopened.pendingIssuances(), ['unknown']);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('single-host broker rejects a supplied store without durable issuance reservations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-unsafe-store-'));
  try {
    assert.throws(() => createSingleHostBroker({ replayPath: join(dir, 'replay.sqlite'), store: { put: async () => {} } }), /durable issuance/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('single-host broker persists replay claims across broker restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-replay-'));
  const path = join(dir, 'replay.sqlite');
  let issued = 0;
  const options = { policy, loadKeys: async () => [key], credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { issued++; return { token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; } }, audit: async () => {} };
  try {
    const first = createSingleHostBroker({ ...options, replayPath: path });
    const token = jwt('persistent-jti');
    await first.exchange(token);
    first.close();
    const second = createSingleHostBroker({ ...options, replayPath: path });
    try { await assert.rejects(second.exchange(token)); } finally { second.close(); }
    assert.equal(issued, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('single-host broker persists credentials across restart for owner revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-credentials-'));
  const credentialKey = randomBytes(32), revoked = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey, installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) }, audit: async () => {} };
  try {
    const first = createSingleHostBroker(options);
    const issued = await first.exchange(jwt('persistent-credential'));
    first.close();
    const second = createSingleHostBroker(options);
    try { await second.revoke(jwt('persistent-revoke'), issued.handle); } finally { second.close(); }
    assert.deepEqual(revoked, ['fixture']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery revokes retained credentials and blocks issuance when recovery fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-startup-'));
  const credentialKey = randomBytes(32), revoked = [];
  let fail = true;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey, installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => { revoked.push(token); if (fail) throw new Error('upstream unavailable'); } }, audit: async () => {} };
  try {
    const first = createSingleHostBroker(options);
    await first.exchange(jwt('startup-issue'));
    first.close();
    await assert.rejects(createRecoveredSingleHostBroker(options), /recovery failed/);
    fail = false;
    const recovered = await createRecoveredSingleHostBroker({ ...options, alert: async () => {} });
    recovered.close();
    assert.deepEqual(revoked, ['fixture', 'fixture']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secure server construction requires successful credential recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-server-recovery-'));
  const credentialKey = randomBytes(32), revoked = [];
  const credentialPath = join(dir, 'credentials.sqlite');
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath, credentialKey, installation: { issue: async () => ({ token: 'fixture' }), revoke: async token => { revoked.push(token); throw new Error('unavailable'); } }, audit: async () => {} };
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('retained', { token: 'fixture' }, 'owner');
    store.close();
    await assert.rejects(createRecoveredSecureServer({}, options), /recovery failed/);
    assert.deepEqual(revoked, ['fixture']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mutating caller policy after construction cannot authorize another repository', async () => {
  const mutablePolicy = { ...policy };
  let issued = 0;
  const broker = createBroker({ policy: mutablePolicy, loadKeys: async () => [key], claimOnce: async () => true, installation: { issue: async () => { issued++; return { token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; } }, store: { put: async () => {} }, audit: async () => {} });
  mutablePolicy.repository_id = '999';
  await assert.rejects(broker.exchange(jwt('changed-policy', { repository_id: '999' })));
  assert.equal(issued, 0);
});

test('exchange and revoke use verified identity and redact audit', async () => {
  const seen = new Set(), entries = new Map(), events = [], revoked = [];
  const store = { put: async (h, c, owner) => entries.set(h, { credential: c, owner }), delete: async h => entries.delete(h), withOwned: async (h, owner, action) => { const entry = entries.get(h); if (!entry || entry.owner !== owner) throw new Error('credential not found'); await action(entry.credential); entries.delete(h); } };
  const installation = { issue: async () => ({ token: 'synthetic-credential', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async jti => { if (seen.has(jti)) return false; seen.add(jti); return true; }, installation, store, audit: async e => events.push(e) });
  const issued = await broker.exchange(jwt('one'));
  assert.equal(issued.token, 'synthetic-credential');
  await assert.rejects(broker.exchange(jwt('one')));
  await assert.rejects(broker.revoke(jwt('two', { repository_id: '999' }), issued.handle));
  assert.equal(revoked.length, 0);
  await broker.revoke(jwt('three'), issued.handle);
  assert.deepEqual(revoked, ['synthetic-credential']);
  assert.equal(entries.size, 0);
  assert.deepEqual(events, ['issued', 'exchange_failed', 'revoke_failed', 'revoked']);
});

test('another run cannot revoke a handle and concurrent revocation is serialized', async () => {
  const entries = new Map(), revoked = [];
  let locked = false;
  const store = {
    put: async (handle, credential, owner) => entries.set(handle, { credential, owner }),
    get: async handle => entries.get(handle)?.credential,
    delete: async handle => entries.delete(handle),
    withOwned: async (handle, owner, action) => {
      const entry = entries.get(handle);
      if (!entry || entry.owner !== owner || locked) throw new Error('credential not found');
      locked = true;
      try { await action(entry.credential); entries.delete(handle); } finally { locked = false; }
    },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => { revoked.push(token); await new Promise(resolve => setTimeout(resolve, 10)); } }, store, audit: async () => {} });
  const issued = await broker.exchange(jwt('owner'));
  await assert.rejects(broker.revoke(jwt('other', { run_id: '101' }), issued.handle));
  assert.equal(revoked.length, 0);
  const results = await Promise.allSettled([broker.revoke(jwt('a'), issued.handle), broker.revoke(jwt('b'), issued.handle)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(revoked, ['fixture']);
});

test('audit failure revokes an issued credential and removes its stored copy', async () => {
  const entries = new Map(), revoked = [];
  const store = { put: async (h, c) => entries.set(h, c), delete: async h => entries.delete(h) };
  const installation = { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, installation, store, audit: async () => { throw new Error('audit unavailable'); } });
  await assert.rejects(broker.exchange(jwt('audit-failure')));
  assert.deepEqual(revoked, ['fixture']);
  assert.equal(entries.size, 0);
});

test('failed credential persistence attempts revocation', async () => {
  const revoked = [];
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) }, store: { put: async () => { throw new Error('storage down'); } }, audit: async () => {} });
  await assert.rejects(broker.exchange(jwt('four')), /broker request failed/);
  assert.deepEqual(revoked, ['fixture']);
});
