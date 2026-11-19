import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createBroker } from './broker.mjs';
import { createAuditedSupervisedServer, createSecureServer } from './tls.mjs';

test('mTLS server accepts an authorized certificate and rejects an anonymous client', async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-broker-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(scratch, 'broker-tls-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=fixture CA', '-days', '1');
    for (const name of ['server', 'client']) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1');
    }
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'untrusted.key', '-out', 'untrusted.crt', '-subj', '/CN=untrusted client', '-days', '1');
    const file = name => readFileSync(join(dir, name));
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
    const policy = { audience: 'isolated', repository_id: '123', repository_owner_id: '456', repository: 'example/test', job_workflow_ref: 'example/test/.github/workflows/trusted.yml@refs/heads/main', ref: 'refs/heads/main', environment: 'test', event_name: 'push', sub: 'repo:example/test:environment:test', workflow_ref: 'example/test/.github/workflows/caller.yml@refs/heads/main', workflow_sha: 'a'.repeat(40), actor: 'trusted', actor_id: '789' };
    const now = Math.floor(Date.now() / 1000);
    const jwt = jti => {
      const claims = { ...policy, iss: 'https://token.actions.githubusercontent.com', aud: policy.audience, iat: now, nbf: now, exp: now + 60, run_id: '100', run_attempt: '1', jti };
      const input = [{ alg: 'RS256', kid: 'fixture' }, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
    };
    const seen = new Set(), entries = new Map(), revoked = [];
    const broker = createBroker({ policy, loadKeys: async () => [key], claimOnce: async jti => { if (seen.has(jti)) return false; seen.add(jti); return true; },
      installation: { issue: async () => ({ token: 'fixture-only', expiresAt: '2030-01-01T00:00:00Z' }), revoke: async token => revoked.push(token) },
      store: { put: async (handle, credential, owner) => entries.set(handle, { credential, owner }), withOwned: async (handle, owner, action) => { const entry = entries.get(handle); if (!entry || entry.owner !== owner) throw new Error('not owned'); await action(entry.credential); entries.delete(handle); } }, audit: async () => {} });
    const server = createSecureServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, broker);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const request = (credentials, path = '/exchange', body = { jwt: jwt('exchange') }) => new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', ca: file('ca.crt'), servername: 'server', ...credentials }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject); req.end(JSON.stringify(body));
      });
      const credentials = { key: file('client.key'), cert: file('client.crt') };
      const ok = await request(credentials);
      assert.equal(ok.status, 200);
      const issued = JSON.parse(ok.body);
      assert.equal(issued.token, 'fixture-only');
      assert.equal((await request(credentials)).status, 403);
      assert.equal((await request(credentials, '/revoke', { jwt: jwt('revoke'), handle: issued.handle })).status, 200);
      assert.deepEqual(revoked, ['fixture-only']);
      await assert.rejects(request({}));
      await assert.rejects(request({ key: file('untrusted.key'), cert: file('untrusted.crt') }));
    } finally { await new Promise(resolve => server.close(resolve)); }

    // Exercise actual mTLS ingress, durable reservation and independent anchors together.
    const anchor = () => {
      let head = { seq: 0, mac: '' };
      return { read: async () => ({ ...head }), compareAndSet: async (previous, next) => {
        if (JSON.stringify(previous) !== JSON.stringify(head)) return false;
        head = { ...next }; return true;
      } };
    };
    const { createCredentialStore } = await import('./store.mjs');
    const { createCredentialCheckpoint } = await import('./credential-checkpoint.mjs');
    async function provisionCredential(options) {
      const store = createCredentialStore(options.credentialPath, options.credentialKey);
      try { await createCredentialCheckpoint(store, options.credentialAnchor, { provision: true }); } finally { store.close(); }
    }
    let issueCount = 0, revokeCount = 0;
    const alerts = [];
    const options = {
      auditPath: join(dir, 'audit.sqlite'), auditKey: randomBytes(32), auditAnchor: anchor(),
      replayPath: join(dir, 'replay.sqlite'), replayKey: randomBytes(32), replayAnchor: anchor(),
      credentialPath: join(dir, 'credentials.sqlite'), credentialKey: randomBytes(32), credentialAnchor: anchor(),
      policy, loadKeys: async () => [key],
      installation: { issue: async () => { issueCount++; throw new Error('upstream response lost'); }, revoke: async () => { revokeCount++; } },
      alert: async event => alerts.push(event), delay: async () => {},
    };
    await provisionCredential(options);
    const supervised = await createAuditedSupervisedServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, options);
    await new Promise(resolve => supervised.listen(0, '127.0.0.1', resolve));
    try {
      const exchange = jti => new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port: supervised.address().port, path: '/exchange', method: 'POST', ca: file('ca.crt'), servername: 'server', key: file('client.key'), cert: file('client.crt') }, res => {
          let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject); req.end(JSON.stringify({ jwt: jwt(jti) }));
      });
      const failed = await exchange('lost-upstream-response');
      assert.equal(failed.status, 403);
      assert.equal(failed.body.includes('upstream response lost'), false);
      assert.equal((await exchange('subsequent-request')).status, 403);
      assert.equal(issueCount, 1);
    } finally { await new Promise(resolve => supervised.close(resolve)); }
    await assert.rejects(createAuditedSupervisedServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, options), /pending issuance/);
    assert.equal(revokeCount, 0);
    assert.ok(alerts.includes('issuance_ambiguous'));

    // A known token survives a revoke failure and is retried before restart can serve.
    let recoveryRevokes = 0;
    const recoveryOptions = {
      ...options,
      auditPath: join(dir, 'recovery-audit.sqlite'), auditAnchor: anchor(),
      replayPath: join(dir, 'recovery-replay.sqlite'), replayAnchor: anchor(),
      credentialPath: join(dir, 'recovery-credentials.sqlite'), credentialAnchor: anchor(),
      installation: {
        issue: async retain => { await retain('retained-fixture'); throw new Error('response processing failed'); },
        revoke: async token => { assert.equal(token, 'retained-fixture'); if (++recoveryRevokes === 1) throw new Error('revoke unavailable'); },
      },
    };
    await provisionCredential(recoveryOptions);
    const recovering = await createAuditedSupervisedServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, recoveryOptions);
    await new Promise(resolve => recovering.listen(0, '127.0.0.1', resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port: recovering.address().port, path: '/exchange', method: 'POST', ca: file('ca.crt'), servername: 'server', key: file('client.key'), cert: file('client.crt') }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end(JSON.stringify({ jwt: jwt('retained-recovery') }));
      });
      assert.equal(response, 403);
    } finally { await new Promise(resolve => recovering.close(resolve)); }
    await assert.rejects(createAuditedSupervisedServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, recoveryOptions), /pending issuance/);
    assert.equal(recoveryRevokes, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
