import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createBroker, createSingleHostBroker, createRecoveredSingleHostBroker, createSupervisedSingleHostBroker } from './broker.mjs';
import * as tls from './tls.mjs';
const { createRecoveredSecureServer } = tls;
import { createCredentialStore } from './store.mjs';
import { createInstallationClient } from './installation.mjs';
import { createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { provisionSqliteAnchor, createSqliteAnchor } from './sqlite-anchor.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const policy = { audience: 'isolated', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push', sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
function jwt(jti, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, ...policy, run_id: '100', run_attempt: '1', jti, ...overrides };
  const input = [ { alg: 'RS256', kid: 'fixture' }, claims ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

test('supervised broker refuses replay database rollback against independent anchor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-replay-anchor-'));
  const replayPath = join(dir, 'replay.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const { copyFileSync } = await import('node:fs');
  provisionSqliteAnchor(anchorPath);
  const replayAnchor = createSqliteAnchor(anchorPath);
  const options = { policy, loadKeys: async () => [key], replayPath, replayKey: randomBytes(32), replayAnchor,
    credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
    installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async () => {} },
    audit: async () => {}, alert: async () => {}, delay: async () => {} };
  try {
    let broker = await createSupervisedSingleHostBroker(options);
    broker.close();
    copyFileSync(replayPath, join(dir, 'snapshot.sqlite'));
    broker = await createSupervisedSingleHostBroker(options);
    await broker.exchange(jwt('rollback-identity'));
    broker.close();
    copyFileSync(join(dir, 'snapshot.sqlite'), replayPath);
    await assert.rejects(createSupervisedSingleHostBroker(options), /replay anchor mismatch/);
  } finally { replayAnchor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('supervised broker alerts when replay anchor is unavailable and refuses startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-replay-alert-'));
  const alerts = [];
  try {
    await assert.rejects(createSupervisedSingleHostBroker({ policy, loadKeys: async () => [key],
      replayPath: join(dir, 'replay.sqlite'), replayKey: randomBytes(32),
      replayAnchor: { read: async () => { throw new Error('anchor offline'); }, compareAndSet: async () => false },
      credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
      installation: { revoke: async () => {} }, audit: async () => {},
      alert: async event => alerts.push(event), delay: async () => {} }), /anchor offline/);
    assert.ok(alerts.includes('replay_unavailable'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('identity expiring during reservation never contacts installation API', async () => {
  let calls = 0;
  const store = { reserveIssuance: async () => { await new Promise(resolve => setTimeout(resolve, 2100)); },
    resolveIssuance: async () => {}, put: async () => {}, queueAlert: async () => {} };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { calls++; return { token: 'fixture' }; } }, audit: async () => {}, alert: async () => {} });
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(broker.exchange(jwt('expires-during-reservation', { iat: now, nbf: now, exp: now + 1 })));
  assert.equal(calls, 0);
});

test('identity expiring during upstream issuance cannot receive a credential', async () => {
  let revoked = 0, pending = false;
  const store = {
    reserveIssuance: async () => { pending = true; },
    resolveIssuance: async () => { pending = false; },
    put: async () => {}, delete: async () => {}, queueAlert: async () => {},
  };
  const installation = {
    issue: async retain => {
      await new Promise(resolve => setTimeout(resolve, 2100));
      await retain('fixture');
      return { token: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    revoke: async () => { revoked++; },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, installation,
    audit: async () => {}, alert: async () => {} });
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(broker.exchange(jwt('expires-during-issuance', { iat: now, nbf: now, exp: now + 1 })));
  assert.equal(revoked, 1);
  assert.equal(pending, true);
});

test('token expiring during issuance audit is not returned and is revoked', async () => {
  let revoked = 0, pending = false;
  const store = {
    reserveIssuance: async () => { pending = true; },
    resolveIssuance: async () => { pending = false; },
    put: async () => {}, delete: async () => {}, queueAlert: async () => {},
  };
  const installation = {
    issue: async retain => {
      const credential = { token: 'fixture', expiresAt: new Date(Date.now() + 100).toISOString() };
      await retain(credential.token);
      return credential;
    },
    revoke: async () => { revoked++; },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, installation,
    audit: async event => { if (event === 'issued') await new Promise(resolve => setTimeout(resolve, 200)); }, alert: async () => {} });
  await assert.rejects(broker.exchange(jwt('expired-during-audit')));
  assert.equal(revoked, 1);
  assert.equal(pending, true);
});

test('lost issuance response leaves anchored intent fenced across restart despite lost local reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-anchored-intent-'));
  const path = join(dir, 'audit.sqlite'), auditKey = randomBytes(32);
  let head = { seq: 0, mac: '' }, calls = 0;
  const anchor = { read: async () => ({ ...head }), compareAndSet: async (old, next) => {
    if (JSON.stringify(old) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  try {
    const audit = await createAsyncAuthenticatedAudit(path, auditKey, anchor);
    const store = { reserveIssuance: async () => {}, queueAlert: async () => { throw new Error('disk lost'); } };
    const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, anchoredIssuance: true,
      installation: { issue: async () => { calls++; throw new Error('response lost'); } }, audit: event => audit.record(event), alert: async () => {} });
    await assert.rejects(broker.exchange(jwt('anchored-response-lost')));
    audit.close();
    await assert.rejects(createAsyncAuthenticatedAudit(path, auditKey, anchor), /pending issuance/);
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real lost upstream HTTP response fences issuance after SQLite and anchor restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-http-loss-'));
  const auditPath = join(dir, 'audit.sqlite'), anchorPath = join(dir, 'anchor.sqlite'), auditKey = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  let anchor = createSqliteAnchor(anchorPath), upstreamCreates = 0;
  const server = createServer((req, res) => { upstreamCreates++; req.resume(); req.on('end', () => res.socket.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const installation = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture',
      request: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/`, options) });
    const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
    const store = { reserveIssuance: async () => {}, queueAlert: async () => {} };
    const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, anchoredIssuance: true,
      installation, audit: event => audit.record(event), alert: async () => {} });
    await assert.rejects(broker.exchange(jwt('http-loss')));
    assert.equal(upstreamCreates, 1);
    audit.close(); anchor.close();
    anchor = createSqliteAnchor(anchorPath);
    await assert.rejects(createAsyncAuthenticatedAudit(auditPath, auditKey, anchor), /pending issuance/);
  } finally { anchor.close(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('storage and revoke failures leave independently anchored issuance fenced after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-storage-revoke-anchor-'));
  const auditPath = join(dir, 'audit.sqlite'), anchorPath = join(dir, 'anchor.sqlite'), auditKey = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  let anchor = createSqliteAnchor(anchorPath), attempts = 0, revocations = 0;
  try {
    const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
    const store = {
      reserveIssuance: async () => {},
      put: async () => { attempts++; throw new Error('storage unavailable'); },
      queueAlert: async () => { throw new Error('outbox unavailable'); },
    };
    const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, anchoredIssuance: true,
      installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => { revocations++; throw new Error('revoke unavailable'); } },
      audit: event => audit.record(event), alert: async () => { throw new Error('alert unavailable'); } });
    await assert.rejects(broker.exchange(jwt('storage-revoke-fail')));
    assert.equal(revocations, 1);
    assert.equal(attempts, 2);
    audit.close(); anchor.close();
    anchor = createSqliteAnchor(anchorPath);
    await assert.rejects(createAsyncAuthenticatedAudit(auditPath, auditKey, anchor), /pending issuance/);
  } finally { anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed revocation remains anchored across restart even if local reservation disappears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-revoke-anchor-'));
  const path = join(dir, 'audit.sqlite'), auditKey = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = { read: async () => ({ ...head }), compareAndSet: async (old, next) => {
    if (JSON.stringify(old) !== JSON.stringify(head)) return false;
    head = { ...next }; return true;
  } };
  try {
    const audit = await createAsyncAuthenticatedAudit(path, auditKey, anchor);
    const store = { reserveIssuance: async () => {}, queueAlert: async () => {},
      withOwned: async (_handle, _owner, callback) => callback({ token: 'fixture' }) };
    const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, anchoredIssuance: true,
      installation: { revoke: async () => { throw new Error('network down'); } }, audit: event => audit.record(event), alert: async () => {} });
    await assert.rejects(broker.revoke(jwt('revoke-anchor'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    audit.close();
    await assert.rejects(createAsyncAuthenticatedAudit(path, auditKey, anchor), /pending issuance/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed revocation fences the running process even if its reservation and outbox disappear', async () => {
  let issued = 0;
  const store = {
    reserveIssuance: async () => {}, resolveIssuance: async () => {},
    queueAlert: async () => { throw new Error('storage unavailable'); },
    withOwned: async (_handle, _owner, action) => action({ token: 'fixture' }),
    put: async () => {},
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { revoke: async () => { throw new Error('network down'); }, issue: async () => { issued++; return { token: 'fixture' }; } },
    audit: async () => {}, alert: async () => { throw new Error('offline'); } });
  await assert.rejects(broker.revoke(jwt('revoke-latch-first'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  await assert.rejects(broker.exchange(jwt('revoke-latch-next')));
  assert.equal(issued, 0);
});

test('ambiguous issuance fences the running process even if its durable reservation disappears', async () => {
  let issued = 0;
  const store = {
    reserveIssuance: async () => {},
    resolveIssuance: async () => {},
    queueAlert: async () => { throw new Error('storage unavailable'); },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { issued++; throw new Error('response lost'); } },
    audit: async () => {}, alert: async () => { throw new Error('offline'); } });
  await assert.rejects(broker.exchange(jwt('ambiguous-latch-first')));
  await assert.rejects(broker.exchange(jwt('ambiguous-latch-next')));
  assert.equal(issued, 1);
});

test('restart without recovery refuses issuance while a previous credential is retained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-restart-retained-'));
  let issued = 0;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => {} }, audit: async () => {}, alert: async () => {} };
  try {
    const first = createSingleHostBroker(options);
    await first.exchange(jwt('restart-retained-first'));
    first.close();
    const second = createSingleHostBroker(options);
    try { await assert.rejects(second.exchange(jwt('restart-retained-second'))); } finally { second.close(); }
    assert.equal(issued, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lost storage-failure finalization acknowledgement fences later issuance when alert storage is down', async () => {
  let pending = false, issued = 0;
  const store = {
    reserveIssuance: async () => { if (pending) throw new Error('pending'); pending = true; },
    resolveIssuance: async () => { pending = false; throw new Error('ack lost'); },
    put: async () => { throw new Error('storage unavailable'); },
    queueAlert: async () => { throw new Error('outbox unavailable'); },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => {} },
    audit: async () => {}, alert: async () => { throw new Error('offline'); } });
  await assert.rejects(broker.exchange(jwt('store-finalization-first')));
  await assert.rejects(broker.exchange(jwt('store-finalization-next')));
  assert.equal(issued, 1);
});

test('transient credential storage failure and failed revoke retain the known token for recovery', async () => {
  let attempts = 0;
  const retained = new Map();
  const store = {
    reserveIssuance: async () => {}, resolveIssuance: async () => assert.fail('must remain fenced'),
    put: async (handle, credential) => { if (++attempts === 1) throw new Error('transient storage failure'); retained.set(handle, credential); },
    queueAlert: async () => {},
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true,
    installation: { issue: async () => ({ token: 'known-fixture' }), revoke: async () => { throw new Error('offline'); } },
    store, audit: async () => {}, alert: async () => {} });
  await assert.rejects(broker.exchange(jwt('store-and-revoke-failure')));
  assert.deepEqual([...retained.values()], [{ token: 'known-fixture' }]);
});

test('rejected upstream token is retained after transient storage failure and failed revoke', async () => {
  let attempts = 0;
  const retained = new Map();
  const store = {
    reserveIssuance: async () => {}, resolveIssuance: async () => assert.fail('must remain fenced'),
    put: async (handle, credential) => { if (++attempts === 1) throw new Error('storage unavailable'); retained.set(handle, credential); },
    queueAlert: async () => {},
  };
  const installation = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture', request: async (_url, options) => options.method === 'DELETE' ? { ok: false } : { ok: true, json: async () => ({ token: 'rejected-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' }, repositories: [{ id: 123 }] }) } });
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, installation, store, audit: async () => {} });
  await assert.rejects(broker.exchange(jwt('rejected-transient-failure')));
  assert.deepEqual([...retained.values()], [{ token: 'rejected-fixture' }]);
});

test('runtime audit failure persists an alert for recovery after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-audit-outbox-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath, credentialKey,
    installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => {} },
    audit: async () => { throw new Error('anchor unavailable'); }, alert: async () => { throw new Error('offline'); } };
  try {
    const broker = createSingleHostBroker(options);
    try { await assert.rejects(broker.exchange(jwt('runtime-audit-failure'))); } finally { broker.close(); }
    const store = createCredentialStore(credentialPath, credentialKey);
    try { assert.ok((await store.pendingAlerts()).includes('audit_unavailable')); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('undelivered runtime audit alert fences subsequent issuance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-audit-fence-'));
  let issued = 0, auditFailed = false;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => {} },
    audit: async event => { if (event === 'issued' && !auditFailed) { auditFailed = true; throw new Error('anchor unavailable'); } }, alert: async () => { throw new Error('offline'); } };
  try {
    const broker = createSingleHostBroker(options);
    try {
      await assert.rejects(broker.exchange(jwt('audit-fence-first')));
      await assert.rejects(broker.exchange(jwt('audit-fence-second')));
      assert.equal(issued, 1);
    } finally { broker.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit failure on another request prevents an in-flight issuance from returning a token', async () => {
  let releaseIssue, startedIssue;
  const started = new Promise(resolve => { startedIssue = resolve; });
  const gate = new Promise(resolve => { releaseIssue = resolve; });
  let revoked = 0, failAudit = true;
  const dir = mkdtempSync(join(tmpdir(), 'broker-inflight-audit-'));
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
    installation: { issue: async () => { startedIssue(); await gate; return { token: 'fixture' }; }, revoke: async () => { revoked++; } },
    audit: async event => { if (event === 'exchange_failed' && failAudit) { failAudit = false; throw new Error('audit unavailable'); } }, alert: async () => {} };
  try {
    const broker = createSingleHostBroker(options);
    try {
      const pending = broker.exchange(jwt('inflight-valid'));
      await started;
      await assert.rejects(broker.exchange(jwt('inflight-invalid', { repository_id: '999' })));
      releaseIssue();
      await assert.rejects(pending);
      assert.equal(revoked, 1);
    } finally { broker.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit failure during reservation prevents an upstream token request', async () => {
  let releaseReservation, reservationStarted;
  const started = new Promise(resolve => { reservationStarted = resolve; });
  const gate = new Promise(resolve => { releaseReservation = resolve; });
  let issued = 0;
  const store = { reserveIssuance: async () => { reservationStarted(); await gate; }, resolveIssuance: async () => {}, put: async () => {}, delete: async () => {}, queueAlert: async () => {} };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => {} },
    audit: async event => { if (event === 'exchange_failed') throw new Error('audit unavailable'); }, alert: async () => {} });
  const pending = broker.exchange(jwt('reservation-valid'));
  await started;
  await assert.rejects(broker.exchange(jwt('reservation-invalid', { repository_id: '999' })));
  releaseReservation();
  await assert.rejects(pending);
  assert.equal(issued, 0);
});

test('concurrent audit failure during anchored intent prevents upstream issuance', async () => {
  let resume, entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let issued = 0;
  const store = { reserveIssuance: async () => {}, queueAlert: async () => {} };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store, anchoredIssuance: true,
    installation: { issue: async () => { issued++; throw new Error('must not issue'); } },
    audit: async event => { if (event === 'issuance_pending') { entered(); await gate; } if (event === 'exchange_failed') throw new Error('audit unavailable'); }, alert: async () => {} });
  const pending = broker.exchange(jwt('anchor-race-valid'));
  await started;
  await assert.rejects(broker.exchange(jwt('anchor-race-invalid', { repository_id: '999' })));
  resume();
  await assert.rejects(pending);
  assert.equal(issued, 0);
});

test('audit failure during issuance finalization prevents returning the token', async () => {
  let finalize, startedFinalize;
  const started = new Promise(resolve => { startedFinalize = resolve; });
  const gate = new Promise(resolve => { finalize = resolve; });
  let revoked = 0;
  const store = { reserveIssuance: async () => {}, resolveIssuance: async () => { startedFinalize(); await gate; }, put: async () => {}, delete: async () => {}, queueAlert: async () => {} };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => ({ token: 'fixture' }), revoke: async () => { revoked++; } },
    audit: async event => { if (event === 'exchange_failed') throw new Error('audit unavailable'); }, alert: async () => {} });
  const pending = broker.exchange(jwt('finalize-valid'));
  await started;
  await assert.rejects(broker.exchange(jwt('finalize-invalid', { repository_id: '999' })));
  finalize();
  await assert.rejects(pending);
  assert.equal(revoked, 1);
});

test('lost revocation finalization acknowledgement and failed outbox fence later issuance', async () => {
  let pending = false, issued = 0;
  const store = {
    reserveIssuance: async () => { if (pending) throw new Error('pending'); pending = true; },
    resolveIssuance: async () => { pending = false; throw new Error('ack lost'); },
    withOwned: async (_handle, _owner, action) => action({ token: 'fixture' }),
    put: async () => {}, queueAlert: async () => { throw new Error('outbox unavailable'); },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { revoke: async () => {}, issue: async () => { issued++; return { token: 'fixture' }; } },
    audit: async () => {}, alert: async () => { throw new Error('offline'); } });
  await assert.rejects(broker.revoke(jwt('revoke-lost-ack'), '00000000-0000-0000-0000-000000000000'));
  await assert.rejects(broker.exchange(jwt('revoke-lost-ack-next')));
  assert.equal(issued, 0);
});

test('audit and outbox failure fences subsequent owner revocation in the running process', async () => {
  let revoked = 0, failAudit = true;
  const store = { reserveIssuance: async () => {}, withOwned: async (_handle, _owner, action) => action({ token: 'fixture' }), resolveIssuance: async () => {}, queueAlert: async () => { throw new Error('disk offline'); } };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { revoke: async () => { revoked++; } },
    audit: async () => { if (failAudit) throw new Error('audit offline'); }, alert: async () => { throw new Error('alert offline'); } });
  await assert.rejects(broker.exchange(jwt('revocation-fence-invalid', { repository_id: '999' })));
  failAudit = false;
  await assert.rejects(broker.revoke(jwt('revocation-fence-next'), '00000000-0000-0000-0000-000000000000'));
  assert.equal(revoked, 0);
});

test('audit and outbox failure on a rejected request fences subsequent issuance in the running process', async () => {
  let issued = 0, failAudit = true;
  const store = { reserveIssuance: async () => {}, resolveIssuance: async () => {}, put: async () => {}, queueAlert: async () => { throw new Error('disk offline'); } };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { issued++; return { token: 'fixture' }; } },
    audit: async () => { if (failAudit) throw new Error('audit offline'); }, alert: async () => { throw new Error('alert offline'); } });
  await assert.rejects(broker.exchange(jwt('outbox-failure-invalid', { repository_id: '999' })));
  failAudit = false;
  await assert.rejects(broker.exchange(jwt('outbox-failure-next')));
  assert.equal(issued, 0);
});

test('audit failure on a rejected request fences issuance until recovery after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-rejected-audit-'));
  let issued = 0, failAudit = true;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32),
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => {} },
    audit: async () => { if (failAudit) throw new Error('audit unavailable'); }, alert: async () => { throw new Error('offline'); } };
  try {
    let broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('bad-identity', { repository_id: '999' })));
    failAudit = false;
    await assert.rejects(broker.exchange(jwt('after-rejected-audit')));
    broker.close();
    broker = createSingleHostBroker(options);
    try { await assert.rejects(broker.exchange(jwt('after-rejected-audit-restart'))); } finally { broker.close(); }
    assert.equal(issued, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lost finalization acknowledgement and failed revoke retain a durable issuance fence', async () => {
  const pending = new Set(), retained = new Map();
  let issued = 0;
  const store = {
    reserveIssuance: async handle => { if (pending.size) throw new Error('already reserved'); pending.add(handle); },
    resolveIssuance: async handle => { pending.delete(handle); throw new Error('acknowledgement lost'); },
    put: async (handle, credential) => retained.set(handle, credential),
    delete: async handle => retained.delete(handle),
    queueAlert: async () => { throw new Error('outbox unavailable'); },
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => { throw new Error('offline'); } },
    audit: async () => {}, alert: async () => { throw new Error('offline'); } });
  await assert.rejects(broker.exchange(jwt('lost-finalization-ack')));
  assert.equal(retained.size, 1);
  assert.equal(pending.size, 1);
  await assert.rejects(broker.exchange(jwt('after-lost-finalization-ack')));
  assert.equal(issued, 1);
});

test('failed issuance finalization immediately revokes the known token while retaining the fence', async () => {
  const retained = new Map(), revoked = [], pending = new Set();
  const store = {
    reserveIssuance: async handle => pending.add(handle),
    resolveIssuance: async () => { throw new Error('storage unavailable'); },
    put: async (handle, credential) => retained.set(handle, credential),
    delete: async handle => retained.delete(handle), queueAlert: async () => {},
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, store,
    installation: { issue: async () => ({ token: 'fixture' }), revoke: async token => revoked.push(token) },
    audit: async () => {}, alert: async () => {} });
  await assert.rejects(broker.exchange(jwt('finalization-revoke')));
  assert.deepEqual(revoked, ['fixture']);
  assert.equal(retained.size, 0);
  assert.equal(pending.size, 1);
});

test('failure to resolve issuance alerts and retains the token for recovery', async () => {
  const alerts = [];
  const retained = new Map();
  const store = {
    reserveIssuance: async () => {},
    resolveIssuance: async () => { throw new Error('storage unavailable'); },
    put: async (handle, credential) => retained.set(handle, credential),
    queueAlert: async event => alerts.push(`queued:${event}`),
  };
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true,
    installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }) },
    store, audit: async () => {}, alert: async event => alerts.push(event) });
  await assert.rejects(broker.exchange(jwt('resolve-failure')));
  assert.equal(retained.size, 1);
  assert.deepEqual(alerts, ['queued:issuance_ambiguous', 'issuance_ambiguous']);
});

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

test('unresolved anchored intent still triggers recovery of retained credentials before refusing startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-pending-recovery-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const auditPath = join(dir, 'audit.sqlite'), auditKey = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => { if (JSON.stringify(previous) !== JSON.stringify(head)) return false; head = { ...next }; return true; } };
  const revoked = [], alerts = [];
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('known', { token: 'fixture-known' }, 'owner');
    await store.reserveIssuance('unknown');
    store.close();
    const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
    await audit.record('issuance_pending');
    audit.close();
    await assert.rejects(tls.createAuditedSupervisedServer({}, {
      auditPath, auditKey, auditAnchor: anchor, credentialPath, credentialKey,
      installation: { revoke: async token => revoked.push(token) }, alert: async event => alerts.push(event),
    }), /pending issuance/);
    assert.deepEqual(revoked, ['fixture-known']);
    assert.ok(alerts.includes('issuance_ambiguous'));
    const reopened = createCredentialStore(credentialPath, credentialKey);
    try { assert.equal((await reopened.pendingIssuances()).length, 1); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anchored pending startup retries failed known-token revocation without opening service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-pending-retry-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const auditPath = join(dir, 'audit.sqlite'), auditKey = randomBytes(32);
  let head = { seq: 0, mac: '' }, attempts = 0, delays = 0;
  const anchor = { read: async () => ({ ...head }), compareAndSet: async (previous, next) => { if (JSON.stringify(previous) !== JSON.stringify(head)) return false; head = { ...next }; return true; } };
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('known', { token: 'fixture-known' }, 'owner');
    await store.reserveIssuance('unknown');
    store.close();
    const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
    await audit.record('issuance_pending');
    audit.close();
    await assert.rejects(tls.createAuditedSupervisedServer({}, {
      auditPath, auditKey, auditAnchor: anchor, credentialPath, credentialKey,
      installation: { revoke: async () => { if (++attempts === 1) throw new Error('offline'); } },
      alert: async () => {}, delay: async () => { delays++; },
    }), /pending issuance/);
    assert.equal(attempts, 2);
    assert.equal(delays, 1);
    const reopened = createCredentialStore(credentialPath, credentialKey);
    try {
      assert.equal(reopened.hasRetainedCredentials(), false);
      assert.equal((await reopened.pendingIssuances()).length, 1);
    } finally { reopened.close(); }
    await assert.rejects(createAsyncAuthenticatedAudit(auditPath, auditKey, anchor), /pending issuance/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anchor mismatch revokes retained known credentials without starting service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-mismatch-recovery-'));
  const credentialPath = join(dir, 'credentials.sqlite'), credentialKey = randomBytes(32);
  const revoked = [], alerts = [];
  try {
    const store = createCredentialStore(credentialPath, credentialKey);
    await store.put('known', { token: 'fixture-known' }, 'owner');
    store.close();
    await assert.rejects(tls.createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => ({ seq: 1, mac: 'a'.repeat(64) }), compareAndSet: async () => true },
      credentialPath, credentialKey, installation: { revoke: async token => revoked.push(token) },
      alert: async event => alerts.push(event),
    }), /anchor mismatch/);
    assert.deepEqual(revoked, ['fixture-known']);
    assert.ok(alerts.includes('audit_unavailable'));
    const reopened = createCredentialStore(credentialPath, credentialKey);
    try { assert.equal(reopened.hasRetainedCredentials(), false); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audited TLS startup reports an unavailable anchor before refusing service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-anchor-alert-'));
  const alerts = [];
  try {
    await assert.rejects(tls.createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('anchor unavailable'); }, compareAndSet: async () => true },
      alert: async event => alerts.push(event),
    }), /anchor unavailable/);
    assert.deepEqual(alerts, ['audit_unavailable']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit startup failure retries a failed alert before returning the startup error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-anchor-retry-'));
  let attempts = 0, delays = 0;
  try {
    await assert.rejects(tls.createAuditedSupervisedServer({}, {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32),
      auditAnchor: { read: async () => { throw new Error('anchor unavailable'); }, compareAndSet: async () => true },
      alert: async event => { assert.equal(event, 'audit_unavailable'); if (++attempts === 1) throw new Error('offline'); },
      delay: async () => { delays++; },
    }), /anchor unavailable/);
    assert.equal(attempts, 2);
    assert.equal(delays, 1);
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

test('closing a broker with an in-flight issuance keeps exclusive ownership until it settles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-close-inflight-'));
  let releaseIssue, started;
  const entered = new Promise(resolve => { started = resolve; });
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { started(); return new Promise(resolve => { releaseIssue = resolve; }); }, revoke: async () => {} }, audit: async () => {} };
  try {
    const broker = createSingleHostBroker(options);
    const exchange = broker.exchange(jwt('close-inflight'));
    await entered;
    assert.throws(() => broker.close(), /in.flight/);
    assert.throws(() => createSingleHostBroker(options), /exclusive/);
    releaseIssue({ token: 'fixture' });
    await exchange;
    broker.close();
    await assert.rejects(broker.exchange(jwt('closed-broker')), /closed/);
    const replacement = createSingleHostBroker(options);
    replacement.close();
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

test('failed owner revocation blocks issuance and alerts across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-revoke-containment-'));
  let issued = 0;
  const alerts = [];
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { issued++; return { token: 'fixture' }; }, revoke: async () => { throw new Error('offline'); } }, audit: async () => {}, alert: async event => alerts.push(event) };
  try {
    let broker = createSingleHostBroker(options);
    const credential = await broker.exchange(jwt('revoke-containment-issue'));
    await assert.rejects(broker.revoke(jwt('revoke-containment-revoke'), credential.handle));
    await assert.rejects(broker.exchange(jwt('revoke-containment-next')));
    broker.close();
    broker = createSingleHostBroker(options);
    await assert.rejects(broker.exchange(jwt('revoke-containment-restart')));
    broker.close();
    assert.equal(issued, 1);
    assert.ok(alerts.includes('credential_recovery_failed'));
    const store = createCredentialStore(options.credentialPath, options.credentialKey);
    try { assert.deepEqual(await store.pendingAlerts(), ['credential_recovery_failed']); } finally { store.close(); }
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

test('failed revocation fences further issuance in the running broker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-revoke-fence-'));
  let issued = 0;
  const options = { policy, loadKeys: async () => [key], replayPath: join(dir, 'replay.sqlite'), credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), installation: { issue: async () => { issued++; return { token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; }, revoke: async () => { throw new Error('unavailable'); } }, audit: async () => {}, alert: async () => {} };
  try {
    const broker = createSingleHostBroker(options);
    try {
      const credential = await broker.exchange(jwt('revoke-fence-first'));
      await assert.rejects(broker.revoke(jwt('revoke-fence-revoke'), credential.handle));
      await assert.rejects(broker.exchange(jwt('revoke-fence-second')));
      assert.equal(issued, 1);
    } finally { broker.close(); }
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
