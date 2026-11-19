import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createBroker } from './broker.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const policy = { audience: 'isolated', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push' };
function jwt(jti, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, ...policy, jti, ...overrides };
  const input = [ { alg: 'RS256', kid: 'fixture' }, claims ].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

test('exchange and revoke use verified identity and redact audit', async () => {
  const seen = new Set(), entries = new Map(), events = [], revoked = [];
  const store = { put: async (h, c) => entries.set(h, c), get: async h => entries.get(h), delete: async h => entries.delete(h) };
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
  assert.deepEqual(events, ['issued', 'revoked']);
});

test('failed credential persistence attempts revocation', async () => {
  const revoked = [];
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async () => true, installation: { issue: async () => ({ token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) }, store: { put: async () => { throw new Error('storage down'); } }, audit: async () => {} });
  await assert.rejects(broker.exchange(jwt('four')), /credential storage failed/);
  assert.deepEqual(revoked, ['fixture']);
});
