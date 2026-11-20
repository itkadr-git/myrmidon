import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createBroker } from './broker.mjs';
import { createHandler } from './http.mjs';

// Exercise the real HTTP parser, broker and signature verifier. Transport trust
// is injected here; tls.test.mjs separately exercises the real mTLS handshake.
test('HTTP exchange rejects signed identity confusion and replay before issuance', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const policy = { audience: 'isolated', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push', sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
  const now = Math.floor(Date.now() / 1000);
  const base = { ...policy, iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, run_id: '100', run_attempt: '1' };
  const encode = (claims, header = { alg: 'RS256', kid: 'fixture' }, signingKey = privateKey) => {
    const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
  };
  const seen = new Set(), entries = new Map(), audit = [], revoked = [];
  let issues = 0;
  const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async jti => { if (seen.has(jti)) return false; seen.add(jti); return true; },
    installation: { issue: async () => { issues++; return { token: 'fixture-credential', expiresAt: '2030-01-01T00:00:00Z' }; }, revoke: async token => revoked.push(token) },
    store: { put: async (handle, credential, owner) => entries.set(handle, { credential, owner }), withOwned: async (handle, owner, action) => { const entry = entries.get(handle); if (!entry || entry.owner !== owner) throw new Error('not owned'); await action(entry.credential); entries.delete(handle); } }, audit: async event => audit.push(event) });
  const handler = createHandler(broker);
  const server = createServer((req, res) => { req.socket.encrypted = true; req.socket.authorized = true; return handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = (path, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST' }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const good = encode({ ...base, jti: 'good' });
    const issued = await post('/exchange', { jwt: good });
    assert.equal(issued.status, 200);
    assert.equal(issued.body.token, 'fixture-credential');
    assert.equal((await post('/exchange', { jwt: good })).status, 403);
    for (const [field, value] of Object.entries({ iss: 'https://attacker.example', aud: 'wrong', repository_id: '999', repository_owner_id: '999', repository: 'fork/test', workflow_ref: 'wrong', workflow_sha: 'b'.repeat(40), job_workflow_ref: 'wrong', ref: 'refs/pull/1/merge', environment: 'wrong', event_name: 'pull_request', sub: 'repo:fork/test:environment:test', actor: 'attacker', actor_id: '999', exp: now - 1, iat: now + 60, nbf: now + 60 })) {
      const result = await post('/exchange', { jwt: encode({ ...base, jti: field, [field]: value }) });
      assert.equal(result.status, 403, field);
      assert.equal(JSON.stringify(result).includes('fixture-credential'), false);
    }
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    for (const token of [encode({ ...base, jti: 'forged' }, undefined, otherKey), encode({ ...base, jti: 'kid' }, { alg: 'RS256', kid: 'wrong' }), encode({ ...base, jti: 'alg' }, { alg: 'none', kid: 'fixture' })]) {
      assert.equal((await post('/exchange', { jwt: token })).status, 403);
    }
    assert.equal((await post('/exchange', { jwt: encode({ ...base, jti: 'scope' }), permissions: { administration: 'write' } })).status, 400);
    assert.equal((await post('/exchange', { jwt: encode({ ...base, jti: 'repository-override' }), repository_ids: [999] })).status, 400);
    assert.equal((await post('/exchange', { jwt: encode({ ...base, jti: 'installation-override' }), installationId: '999' })).status, 400);
    assert.equal(issues, 1);
    assert.equal((await post('/revoke', { jwt: encode({ ...base, jti: 'other-run', run_id: '101' }), handle: issued.body.handle })).status, 403);
    assert.equal((await post('/revoke', { jwt: encode({ ...base, jti: 'revoke' }), handle: issued.body.handle })).status, 200);
    assert.deepEqual(revoked, ['fixture-credential']);
    assert.equal(JSON.stringify(audit).includes('fixture-credential'), false);
    assert.equal(JSON.stringify(audit).includes(good), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
