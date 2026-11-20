import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('gateway to separate mTLS upstream: conditional GET path, tenant boundaries and TLS authentication', async (t) => {
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
  // Mutable state for the issues the fixture knows. Every simulated mutation
  // bumps `version` alongside the document generation, mirroring the board
  // triggers: no ABA class is invisible.
  const state = {
    'OPE-1': { issue: { id, identifier: 'OPE-1', companyId: 'allowed', version: '1' }, document: { id: 'doc', latestRevisionId: 'rev', latestRevisionNumber: 1, body: 'criteria', secret: 'private-document' } },
    'OPE-3': { issue: { id: id3, identifier: 'OPE-3', companyId: 'allowed', version: '1' }, document: null },
    'OPE-5': { issue: { id: id5, identifier: 'OPE-5', companyId: 'allowed', version: '1' }, document: { id: 'aba-doc', latestRevisionId: 'p1', latestRevisionNumber: 1, body: 'criteria-1', secret: 'private-document' } },
  };
  let upstreamRequests = 0;
  const requestedPaths = [];
  const serviceToken = `myrmidon_svc_${'a'.repeat(43)}`;
  writeFileSync(file('service-token'), serviceToken, { mode: 0o600 });
  const findState = (url) => Object.values(state).find((entry) => url.includes(entry.issue.id) || url.includes(entry.issue.identifier));
  const upstream = createServer({ ...upstreamTls, ca: clientTls.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    upstreamRequests++;
    requestedPaths.push(req.url);
    if (req.headers.authorization !== `Bearer ${serviceToken}`) { res.writeHead(401); res.end(); return; }
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
    const entry = findState(req.url);
    if (!entry || entry.issue.companyId !== 'allowed') {
      // Foreign AND unknown issues are the identical upstream 404.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Issue not found' }));
      return;
    }
    const etag = `"${createHash('sha256').update(JSON.stringify([entry.issue.id, entry.issue.version, entry.document?.latestRevisionId ?? null])).digest('hex')}"`;
    if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', etag });
    res.end(JSON.stringify({ issue: { ...entry.issue, secret: 'private-relation' }, document: entry.document }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const origin = `https://localhost:${upstream.address().port}`;
  await assert.rejects(createUpstream({ origin, ca: wrongTls.cert, ...clientTls, token: serviceToken }).readSnapshot('OPE-1'));
  await assert.rejects(createUpstream({ origin, ca: upstreamTls.cert, ...wrongTls, token: serviceToken }).readSnapshot('OPE-1'));
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
  const gateway = start({ host: '127.0.0.1', port, credentialDirectory, auditFile: file('audit.jsonl'), listener: { cert: file('gateway.crt'), key: file('gateway.key') }, upstream: { origin, ca: file('upstream.crt'), cert: file('client.crt'), key: file('client.key'), tokenFile: file('service-token') } });
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  const call = (path, { method = 'GET', body, headers = { authorization: `Bearer ${token}` } } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', servername: 'localhost', port: gateway.address().port, ca: gatewayTls.cert, path, method, headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  // Every allowed request is exactly one upstream read of the snapshot path.
  const projected = (entry) => ({
    issue: entry.issue,
    document: entry.document == null ? null : { id: entry.document.id, latestRevisionId: entry.document.latestRevisionId, latestRevisionNumber: entry.document.latestRevisionNumber, body: entry.document.body },
  });
  for (const ref of ['OPE-1', id]) {
    assert.deepEqual(JSON.parse((await call(`/api/issues/${ref}/acceptance-snapshot`)).body), projected(state['OPE-1']));
  }
  for (const requested of requestedPaths) {
    assert.match(requested, /^\/api\/service\/issues\/(?:OPE-1|11111111-1111-1111-1111-111111111111)\/acceptance-scenarios$/);
  }
  // An issue whose snapshot carries no document still pins.
  assert.deepEqual(JSON.parse((await call('/api/issues/OPE-3/acceptance-snapshot')).body), projected(state['OPE-3']));

  // Conditional GET passes the strong snapshot ETag upstream and fails closed
  // when content or issue epoch changes, including an ABA content revert.
  const path = '/api/issues/OPE-5/acceptance-snapshot';
  const first = await call(path);
  const conditional = { authorization: `Bearer ${token}`, 'if-match': first.headers.etag };
  assert.equal((await call(path, { headers: conditional })).status, 200);
  state['OPE-5'].document = { id: 'aba-doc', latestRevisionId: 'p2', latestRevisionNumber: 2, body: 'criteria-2' };
  state['OPE-5'].issue.version = '2';
  assert.equal((await call(path, { headers: conditional })).status, 412);
  state['OPE-5'].document = { id: 'aba-doc', latestRevisionId: 'p3', latestRevisionNumber: 3, body: 'criteria-1' };
  state['OPE-5'].issue.version = '3';
  assert.equal((await call(path, { headers: conditional })).status, 412);
  state['OPE-5'].issue.companyId = 'other';
  assert.equal((await call(path, { headers: conditional })).status, 404);

  // Foreign and unknown issues are the identical 404.
  const foreign404 = await call(`/api/issues/${foreign}/acceptance-snapshot`);
  const unknown404 = await call('/api/issues/99999999-9999-9999-9999-999999999999/acceptance-snapshot');
  assert.equal(foreign404.status, 404);
  assert.equal(unknown404.status, 404);
  assert.deepEqual(JSON.parse(foreign404.body), JSON.parse(unknown404.body));
  assert.equal((await call('/api/issues/OPE-2/acceptance-snapshot')).status, 404);

  // Upstream failure classes never surface as a partial snapshot.
  for (const ref of ['OPE-9', 'OPE-8', 'OPE-6']) {
    const failed = await call(`/api/issues/${ref}/acceptance-snapshot`);
    assert.equal(failed.status, 502, ref);
    assert.deepEqual(JSON.parse(failed.body), {}, ref);
  }

  const beforeState = JSON.stringify(state);
  const before = upstreamRequests;
  for (const path of ['/api/issues', '/api/issues?search=OPE', '/api/issues/OPE-1/documents/acceptance-scenarios', '/api/issues/OPE-1/acceptance-scenarios-snapshot', '/api/secrets', '/api/agents', '/api/plugins', '/api/issues/%4fPE-1/acceptance-snapshot', '/api/issues/%254fPE-1/acceptance-snapshot', '/api/issues/OPE-1%2facceptance-snapshot', '/api/issues/../OPE-1/acceptance-snapshot', '/api/issues/OPE-1/acceptance-snapshot?x=1']) assert.equal((await call(path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot', { method })).status, 404, method);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot/verify', { method })).status, 404);
  for (const header of ['x-http-method-override', 'x-method-override', 'x-http-method']) assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot', { headers: { authorization: `Bearer ${token}`, [header]: 'POST' } })).status, 404, header);
  for (const authorization of [undefined, 'Bearer invalid', 'Basic candidate']) assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot', { headers: authorization ? { authorization } : {} })).status, 401);
  assert.equal(upstreamRequests, before);
  assert.equal(JSON.stringify(state), beforeState);
  const expired = 'candidate-expired-token';
  store.issue({ tokenHash: createHash('sha256').update(expired).digest('hex'), companyId: 'allowed', expiresAt: Date.now() - 1 });
  assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot', { headers: { authorization: `Bearer ${expired}` } })).status, 401);
  store.revoke(records[0].tokenHash);
  assert.equal((await call('/api/issues/OPE-1/acceptance-snapshot')).status, 401);
  assert.equal(upstreamRequests, before);
  const audit = readFileSync(file('audit.jsonl'), 'utf8');
  assert.ok(audit.length > 0);
  for (const secret of [token, serviceToken, expired, 'private-relation', 'private-document', 'criteria', 'criteria-1']) assert.ok(!audit.includes(secret), secret);
});
