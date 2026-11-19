import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyIdentity } from './identity.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const policy = { audience: 'isolated-broker', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push', sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
const claims = { iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, jti: 'fixture-id', ...policy };
function jwt(payload = claims, header = { alg: 'RS256', kid: 'fixture', typ: 'JWT' }, key = privateKey) {
  const input = [header, payload].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
test('accepts signed pinned identity; rejects tampering and policy confusion', async () => {
  const seen = new Set();
  const verify = token => verifyIdentity(token, { policy, loadKeys: async () => [jwk], claimOnce: async jti => { if (seen.has(jti)) return false; seen.add(jti); return true; }, now });
  assert.equal((await verify(jwt())).repository_id, '123');
  await assert.rejects(verify(jwt()));
  for (const field of ['repository_id', 'repository_owner_id', 'repository', 'job_workflow_ref', 'ref', 'environment', 'event_name', 'aud']) {
    await assert.rejects(verify(jwt({ ...claims, [field]: 'wrong', jti: field })));
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verify(jwt({ ...claims, jti: 'forged' }, undefined, other.privateKey)));
  await assert.rejects(verify(jwt({ ...claims, jti: 'unknown' }, { alg: 'RS256', kid: 'unknown' })));
  await assert.rejects(verify(jwt({ ...claims, jti: 'none' }, { alg: 'none', kid: 'fixture' })));
  await assert.rejects(verify(jwt({ ...claims, jti: 'expired', exp: now - 1 })));
  await assert.rejects(verify(jwt({ ...claims, jti: 'future', nbf: now + 60 })));
});

test('rejects an untrusted caller workflow, subject or actor', async () => {
  const caller = { sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
  const verify = token => verifyIdentity(token, { policy: { ...policy, ...caller }, loadKeys: async () => [jwk], claimOnce: async () => true, now });
  await verify(jwt({ ...claims, ...caller }));
  for (const field of Object.keys(caller)) {
    await assert.rejects(verify(jwt({ ...claims, ...caller, [field]: 'untrusted' })), field);
  }
  await assert.rejects(verify(jwt({ ...claims, workflow_ref: undefined })));
});

test('rejects nonnumeric actor identity even when policy matches', async () => {
  const invalidPolicy = { ...policy, actor_id: 'not-numeric' };
  const invalidClaims = { ...claims, actor_id: 'not-numeric' };
  await assert.rejects(verifyIdentity(jwt(invalidClaims), { policy: invalidPolicy, loadKeys: async () => [jwk], claimOnce: async () => true, now }));
});

test('rejects excessively long-lived or stale signed identities', async () => {
  const verify = token => verifyIdentity(token, { policy, loadKeys: async () => [jwk], claimOnce: async () => true, now });
  await assert.rejects(verify(jwt({ ...claims, exp: now + 365 * 86400 })));
  await assert.rejects(verify(jwt({ ...claims, iat: now - 601, nbf: now - 601, exp: now + 1 })));
});
