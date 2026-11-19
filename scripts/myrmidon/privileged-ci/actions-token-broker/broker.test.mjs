import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createBroker, createSingleHostBroker } from './broker.mjs';
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

test('single-host broker persists replay claims across broker restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-replay-'));
  const path = join(dir, 'replay.sqlite');
  let issued = 0;
  const options = { policy, loadKeys: async () => [key], installation: { issue: async () => { issued++; return { token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; } }, store: { put: async () => {} }, audit: async () => {} };
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
