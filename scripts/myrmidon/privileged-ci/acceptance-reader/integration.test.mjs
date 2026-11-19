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

test('gateway to separate mTLS upstream: one atomic snapshot read per request, tenant boundaries and TLS authentication', async (t) => {
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
  const id3 = '33333333-3333-3333-3333-333333333333';
  const id5 = '55555555-5555-5555-5555-555555555555';
  const foreign = '22222222-2222-2222-2222-222222222222';
  // Mutable document state for the ABA regression: every write mints a new
  // (revisionId, revisionNumber) pair, mirroring the board's write path.
  const aba = { revisionId: 'aba-r1', revisionNumber: 1, body: 'criteria-1' };
  let upstreamRequests = 0;
  const requestedPaths = [];
  // The upstream fixture implements the atomic snapshot contract with the
  // board's no-existence-oracle semantics: known issues get one snapshot
  // response; foreign and unknown issues get the identical 404; other
  // statuses exercise the failure classes.
  const upstream = createServer({ ...upstreamTls, ca: clientTls.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    upstreamRequests++;
    requestedPaths.push(req.url);
    if (req.url.includes('OPE-6')) { req.socket.destroy(); return; }
    if (req.url.includes('OPE-9')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream failure' }));
      return;
    }
    if (req.url.includes('OPE-8')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-json');
      return;
    }
    const isDocumentless = req.url.includes('OPE-3') || req.url.includes(id3);
    const isAba = req.url.includes('OPE-5') || req.url.includes(id5);
    const isKnown = req.url.includes('OPE-1') || req.url.includes(id) || isDocumentless || isAba;
    if (!isKnown) {
      // Foreign AND unknown issues are the identical upstream 404.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Issue not found' }));
      return;
    }
    const issue = isDocumentless
      ? { id: id3, identifier: 'OPE-3', companyId: 'allowed', secret: 'private-relation' }
      : isAba
        ? { id: id5, identifier: 'OPE-5', companyId: 'allowed', secret: 'private-relation' }
        : { id, identifier: 'OPE-1', companyId: 'allowed', secret: 'private-relation' };
    const document = isDocumentless
      ? null
      : isAba
        ? { id: 'aba-doc', latestRevisionId: aba.revisionId, latestRevisionNumber: aba.revisionNumber, body: aba.body, secret: 'private-document' }
        : { id: 'doc', latestRevisionId: 'rev', latestRevisionNumber: 1, body: 'criteria', secret: 'private-document' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ issue, document }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const origin = `https://localhost:${upstream.address().port}`;
  const adapter = createUpstream({ origin, ca: upstreamTls.cert, ...clientTls });
  await assert.rejects(createUpstream({ origin, ca: wrongTls.cert, ...clientTls }).readSnapshot('OPE-1'));
  await assert.rejects(createUpstream({ origin, ca: upstreamTls.cert, ...wrongTls }).readSnapshot('OPE-1'));
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
  // Every allowed request is exactly one upstream read of the snapshot path.
  for (const identifier of ['OPE-1', id]) {
    assert.deepEqual(JSON.parse((await call(`/api/issues/${identifier}`)).body), { id, identifier: 'OPE-1', companyId: 'allowed' });
    assert.deepEqual(JSON.parse((await call(`/api/issues/${identifier}/documents/acceptance-scenarios`)).body), { id: 'doc', latestRevisionId: 'rev', latestRevisionNumber: 1, body: 'criteria' });
  }
  for (const requested of requestedPaths) {
    assert.match(requested, /^\/api\/issues\/(?:OPE-1|11111111-1111-1111-1111-111111111111)\/acceptance-scenarios-snapshot$/);
  }
  // ABA between requests, the reviewer's blocking finding: every document
  // write mints a new (latestRevisionId, latestRevisionNumber) pair, so a
  // content revert (r1 -> r2 -> r1) still changes the monotonic generation
  // and a strict tuple equality across reads detects the change.
  const readAba = async () => {
    const result = await call('/api/issues/OPE-5/documents/acceptance-scenarios');
    assert.equal(result.status, 200);
    const document = JSON.parse(result.body);
    assert.ok(Number.isInteger(document.latestRevisionNumber) && document.latestRevisionNumber > 0, 'monotonic generation is exposed');
    return document;
  };
  const tupleOf = (document) => [document.latestRevisionId, document.latestRevisionNumber];
  const first = await readAba();
  aba.revisionId = 'aba-r2'; aba.revisionNumber = 2; aba.body = 'criteria-2';
  const second = await readAba();
  aba.revisionId = 'aba-r1'; aba.revisionNumber = 3; aba.body = 'criteria-1';
  const third = await readAba();
  assert.notDeepEqual(tupleOf(first), tupleOf(second));
  assert.notDeepEqual(tupleOf(second), tupleOf(third));
  assert.equal(first.latestRevisionId, third.latestRevisionId);
  assert.notEqual(first.latestRevisionNumber, third.latestRevisionNumber, 'content ABA is still a new generation');
  // Late invalidation before the result: pin with a first read, re-verify
  // with a fresh read right before the result, and observe that a write
  // after the verification changes the tuple — the gateway never claims
  // post-publication invalidation, the contract requires the fresh re-check.
  const pin = await readAba();
  const verify = await readAba();
  assert.deepEqual(tupleOf(pin), tupleOf(verify));
  aba.revisionId = 'aba-r4'; aba.revisionNumber = 4; aba.body = 'criteria-4';
  const after = await readAba();
  assert.notDeepEqual(tupleOf(verify), tupleOf(after));
  // An issue whose snapshot carries no document still serves the issue projection.
  assert.deepEqual(JSON.parse((await call('/api/issues/OPE-3')).body), { id: id3, identifier: 'OPE-3', companyId: 'allowed' });
  assert.equal((await call('/api/issues/OPE-3/documents/acceptance-scenarios')).status, 404);
  // Foreign and unknown issues are the identical 404: no existence oracle.
  const foreign404 = await call(`/api/issues/${foreign}`);
  const unknown404 = await call('/api/issues/99999999-9999-9999-9999-999999999999');
  for (const identifier of ['OPE-2', foreign]) {
    assert.equal((await call(`/api/issues/${identifier}`)).status, 404);
    assert.equal((await call(`/api/issues/${identifier}/documents/acceptance-scenarios`)).status, 404);
  }
  assert.equal(unknown404.status, 404);
  assert.equal(foreign404.status, 404);
  assert.deepEqual(JSON.parse(foreign404.body), JSON.parse(unknown404.body));
  // Upstream failure classes never surface as a partial snapshot; each is a
  // bare 502, indistinguishable from the others.
  for (const identifier of ['OPE-9', 'OPE-8', 'OPE-6']) {
    const failed = await call(`/api/issues/${identifier}`);
    assert.equal(failed.status, 502, identifier);
    assert.deepEqual(JSON.parse(failed.body), {}, identifier);
  }
  const before = upstreamRequests;
  for (const path of ['/api/issues', '/api/issues?search=OPE', '/api/issues/OPE-1/documents/plan', '/api/issues/OPE-1/acceptance-scenarios-snapshot', '/api/secrets', '/api/agents', '/api/plugins', '/api/issues/%4fPE-1', '/api/issues/%254fPE-1', '/api/issues/OPE-1%2fdocuments%2facceptance-scenarios', '/api/issues/../OPE-1', '/api/issues/OPE-1?x=1']) assert.equal((await call(path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await call('/api/issues/OPE-1', { method })).status, 404, method);
  for (const header of ['x-http-method-override', 'x-method-override', 'x-http-method']) assert.equal((await call('/api/issues/OPE-1', { headers: { authorization: `Bearer ${token}`, [header]: 'POST' } })).status, 404, header);
  for (const authorization of [undefined, 'Bearer invalid', 'Basic candidate']) assert.equal((await call('/api/issues/OPE-1', { headers: authorization ? { authorization } : {} })).status, 401);
  assert.equal(upstreamRequests, before);
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
