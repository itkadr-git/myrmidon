import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:https';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createUpstream } from './upstream.mjs';
import { start } from './main.mjs';
import { createPersistentCredentialStore } from './persistent-credentials.mjs';
import { mkdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';

test('gateway to separate mTLS upstream: projections, tenant boundaries and TLS authentication', async (t) => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || process.env.HOME, 'reader-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name) => join(dir, name);
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
  const pair = (name) => {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file(`${name}.key`), '-out', file(`${name}.crt`), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost');
    return { key: readFileSync(file(`${name}.key`)), cert: readFileSync(file(`${name}.crt`)) };
  };
  const upstreamTls = pair('upstream');
  const clientTls = pair('client');
  const wrongTls = pair('wrong');
  const gatewayTls = pair('gateway');
  const id = '11111111-1111-1111-1111-111111111111';
  const foreign = '22222222-2222-2222-2222-222222222222';
  let upstreamRequests = 0;
  const upstreamState = { issue: 'original', document: 'original' };
  const upstream = createServer({ ...upstreamTls, ca: clientTls.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    upstreamRequests++;
    if (req.method !== 'GET') upstreamState.document = 'mutated';
    const isForeign = req.url.includes(foreign) || req.url.includes('OPE-2');
    const issue = { id: isForeign ? foreign : id, identifier: isForeign ? 'OPE-2' : 'OPE-1', companyId: isForeign ? 'other' : 'allowed', secret: 'private-relation' };
    const doc = { id: 'doc', issueId: issue.id, companyId: issue.companyId, key: 'acceptance-scenarios', latestRevisionId: 'rev', body: 'criteria', secret: 'private-document' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/acceptance-scenarios') ? doc : issue));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const origin = `https://localhost:${upstream.address().port}`;
  const adapter = createUpstream({ origin, ca: upstreamTls.cert, ...clientTls });
  await assert.rejects(createUpstream({ origin, ca: wrongTls.cert, ...clientTls }).readIssue('OPE-1'));
  await assert.rejects(createUpstream({ origin, ca: upstreamTls.cert, ...wrongTls }).readIssue('OPE-1'));
  const token = 'candidate-integration-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'allowed', expiresAt: Date.now() + 60000, revoked: false }];
  const credentialDirectory = file('credentials');
  mkdirSync(credentialDirectory);
  const store = createPersistentCredentialStore(credentialDirectory);
  store.issue(records[0]);
  const reservation = createNetServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const gateway = start({ host: '127.0.0.1', port, credentialDirectory, auditFile: file('audit.jsonl'), listener: { cert: file('gateway.crt'), key: file('gateway.key') }, upstream: { origin, ca: file('upstream.crt'), cert: file('client.crt'), key: file('client.key') } });
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  const call = (path, options = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', servername: 'localhost', port: gateway.address().port, ca: gatewayTls.cert, path, headers: { authorization: `Bearer ${token}` }, ...options }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  for (const identifier of ['OPE-1', id]) {
    assert.deepEqual(JSON.parse((await call(`/api/issues/${identifier}`)).body), { identifier: 'OPE-1', companyId: 'allowed' });
    assert.deepEqual(JSON.parse((await call(`/api/issues/${identifier}/documents/acceptance-scenarios`)).body), { id: 'doc', latestRevisionId: 'rev', body: 'criteria' });
  }
  for (const identifier of ['OPE-2', foreign]) {
    assert.equal((await call(`/api/issues/${identifier}`)).status, 404);
    assert.equal((await call(`/api/issues/${identifier}/documents/acceptance-scenarios`)).status, 404);
  }
  const before = upstreamRequests;
  const stateBefore = structuredClone(upstreamState);
  for (const path of ['/api/issues', '/api/issues?search=OPE', '/api/issues/OPE-1/documents/plan', '/api/secrets', '/api/agents', '/api/plugins', '/api/issues/%4fPE-1', '/api/issues/%254fPE-1', '/api/issues/OPE-1%2fdocuments%2facceptance-scenarios', '/api/issues/../OPE-1', '/api/issues/OPE-1?x=1']) assert.equal((await call(path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await call('/api/issues/OPE-1', { method })).status, 404, method);
  for (const header of ['x-http-method-override', 'x-method-override', 'x-http-method']) assert.equal((await call('/api/issues/OPE-1', { headers: { authorization: `Bearer ${token}`, [header]: 'POST' } })).status, 404, header);
  for (const authorization of [undefined, 'Bearer invalid', 'Basic candidate']) assert.equal((await call('/api/issues/OPE-1', { headers: authorization ? { authorization } : {} })).status, 401);
  assert.equal(upstreamRequests, before);
  assert.deepEqual(upstreamState, stateBefore);
  const expired = 'candidate-expired-token';
  store.issue({ tokenHash: createHash('sha256').update(expired).digest('hex'), companyId: 'allowed', expiresAt: Date.now() - 1 });
  assert.equal((await call('/api/issues/OPE-1', { headers: { authorization: `Bearer ${expired}` } })).status, 401);
  store.revoke(records[0].tokenHash);
  assert.equal((await call('/api/issues/OPE-1')).status, 401);
  assert.equal(upstreamRequests, before);
  const audit = readFileSync(file('audit.jsonl'), 'utf8');
  assert.ok(audit.length > 0);
  for (const secret of [token, expired, 'private-relation', 'private-document', 'criteria']) assert.ok(!audit.includes(secret));
});
