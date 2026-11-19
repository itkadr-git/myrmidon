import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, authenticate, createHandler } from './reader.mjs';
import { createServer, get, request } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCredentialStore } from './credentials.mjs';

const token = 'candidate-test-token';
const hash = () => createHash('sha256').update(token).digest('hex');
const records = (companyId = 'company-a') => [{ tokenHash: hash(), companyId, expiresAt: Date.now() + 60000, revoked: false }];

const snapshot = (over = {}) => ({
  issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 3, ...over.issue },
  document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 2, body: 'criteria', secret: 'hidden', ...over.document },
});

const serve = async (t, handlerOptions) => {
  const server = createServer(createHandler(handlerOptions));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return (path, { method = 'GET', body, headers = { authorization: `Bearer ${token}` } } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

test('credential binding rejects expired revoked and wrong bearer', () => {
  const record = { tokenHash: hash(), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.equal(authenticate(`Bearer ${token}`, [record], 1000), 'company-a');
  assert.equal(authenticate('Bearer wrong', [record], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [{ ...record, revoked: true }], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [record], 2000), null);
  assert.equal(authenticate(undefined, [record], 1000), null);
});

test('duplicate credential records fail closed, even when one is revoked or has another company', () => {
  const record = { tokenHash: hash(), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.equal(authenticate(`Bearer ${token}`, [record, { ...record, revoked: true }], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [record, { ...record, companyId: 'company-b' }], 1000), null);
});

test('accepts only the pin and verify paths', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123/acceptance-snapshot'), { issue: 'OPE-123', verify: false });
  assert.deepEqual(parsePath('/api/issues/OPE-123/acceptance-snapshot/verify'), { issue: 'OPE-123', verify: true });
  for (const path of ['/api/issues/OPE-123', '/api/issues/OPE-123?x=1', '/api/issues/OPE-123/documents/acceptance-scenarios', '/api/issues/%4fPE-123/acceptance-snapshot', '/api/issues/OPE-123/acceptance-snapshot/', '/api/issues/OPE-123/acceptance-scenarios-snapshot', '/api/issues/../OPE-123/acceptance-snapshot']) {
    assert.equal(parsePath(path), null, path);
  }
});

test('pin route returns the full single-snapshot projection', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => snapshot() });
  const result = await request('/api/issues/OPE-123/acceptance-snapshot');
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body);
  assert.deepEqual(body, {
    issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 3 },
    document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 2, body: 'criteria' },
  });
  // Runner-facing projection must not leak upstream-only fields.
  assert.ok(!JSON.stringify(body).includes('hidden'));
});

test('verify asserts the pinned snapshot server-side against a fresh read', async (t) => {
  let current = snapshot();
  const request = await serve(t, { records: records(), readSnapshot: async () => current });
  const pin = JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot')).body);
  assert.deepEqual(JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: pin })).body), { ok: true });
  // Content mutation moves the generation: the stale pin is rejected.
  current = snapshot({ document: { id: 'doc-id', latestRevisionId: 'rev-2', latestRevisionNumber: 3, body: 'criteria' } });
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: pin })).status, 409);
  // Issue identity ABA moves the version: still rejected.
  current = snapshot({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 4 } });
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: pin })).status, 409);
  // A fresh pin matches again — including after an A->B->A revert.
  current = snapshot({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 5 } });
  const rePin = JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot')).body);
  assert.deepEqual(JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: rePin })).body), { ok: true });
});

test('verify rejects malformed pins and unbound identities without disclosure', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => snapshot() });
  const pin = JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot')).body);
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: 'not-json' })).status, 400);
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: { issue: { id: 'issue-id' } } })).status, 400);
  const foreign = { ...pin, issue: { ...pin.issue, companyId: 'company-b' } };
  const denied = await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: foreign });
  assert.equal(denied.status, 404);
  assert.ok(!denied.body.includes('company-b'));
  // Verify on an unknown issue is the identical 404.
  const unknown = await serve(t, { records: records(), readSnapshot: async () => null });
  assert.equal((await unknown('/api/issues/OPE-124/acceptance-snapshot/verify', { method: 'POST', body: pin })).status, 404);
  assert.equal((await unknown('/api/issues/OPE-124/acceptance-snapshot')).status, 404);
});

test('revocation during upstream lookup fails closed and audit excludes request data', async (t) => {
  const mutable = records();
  const events = [];
  const request = await serve(t, {
    records: mutable,
    audit: async (event) => events.push(event),
    readSnapshot: async () => {
      mutable[0].revoked = true;
      return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 1 }, document: null };
    },
  });
  const result = await request('/api/issues/OPE-123/acceptance-snapshot');
  assert.equal(result.status, 401);
  assert.ok(!result.body.includes('issue-id'));
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(token));
  assert.ok(!JSON.stringify(events).includes('hidden'));
});

test('duplicate authorization headers are rejected before upstream access', async (t) => {
  let reads = 0;
  const server = createServer(createHandler({
    records: records(),
    readSnapshot: async () => { reads += 1; return snapshot(); },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123/acceptance-snapshot', headers: ['Host', 'localhost', 'Authorization', `Bearer ${token}`, 'Authorization', 'Bearer another-candidate-token'] }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).on('error', reject));
  assert.equal(status, 401);
  assert.equal(reads, 0);
});

test('handler accepts the immutable credential store and observes revocation', async (t) => {
  const store = createCredentialStore(records());
  const request = await serve(t, {
    credentialStore: store,
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 1 }, document: null }),
  });
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot')).status, 200);
  store.revoke(hash());
  assert.equal((await request('/api/issues/OPE-123/acceptance-snapshot')).status, 401);
});

test('an invalid upstream payload fails as 502, never as a partial snapshot', async (t) => {
  for (const bad of [
    {},
    { issue: null },
    { issue: { id: 'issue-id', identifier: 'OPE-123' } },
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' } },
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 1 }, document: { id: 'doc-id' } },
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: 1 }, document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 0, body: 'criteria' } },
  ]) {
    const request = await serve(t, { records: records(), readSnapshot: async () => bad });
    for (const path of ['/api/issues/OPE-123/acceptance-snapshot', '/api/issues/OPE-123/acceptance-snapshot/verify']) {
      const result = await request(path, path.endsWith('/verify') ? { method: 'POST', body: {} } : {});
      assert.equal(result.status, 502, `${path} ${JSON.stringify(bad)}`);
      assert.deepEqual(JSON.parse(result.body), {});
    }
  }
});

test('read errors never return a partial mixed snapshot', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => { throw new Error('upstream read failed'); } });
  const pin = await request('/api/issues/OPE-123/acceptance-snapshot');
  const verify = await request('/api/issues/OPE-123/acceptance-snapshot/verify', { method: 'POST', body: {} });
  assert.equal(pin.status, 502);
  assert.equal(verify.status, 502);
  assert.deepEqual(JSON.parse(pin.body), {});
  assert.deepEqual(JSON.parse(verify.body), {});
});
