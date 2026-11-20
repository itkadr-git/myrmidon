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
  issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '3', ...over.issue },
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
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
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

test('accepts only the snapshot path', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123/acceptance-snapshot'), { issue: 'OPE-123' });
  for (const path of ['/api/issues/OPE-123/acceptance-snapshot/verify', '/api/issues/OPE-123', '/api/issues/OPE-123?x=1', '/api/issues/OPE-123/documents/acceptance-scenarios', '/api/issues/%4fPE-123/acceptance-snapshot', '/api/issues/OPE-123/acceptance-snapshot/', '/api/issues/../OPE-123/acceptance-snapshot']) assert.equal(parsePath(path), null, path);
});

test('pin route returns the full single-snapshot projection', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => snapshot() });
  const result = await request('/api/issues/OPE-123/acceptance-snapshot');
  assert.equal(result.status, 200);
  const body = JSON.parse(result.body);
  assert.deepEqual(body, {
    issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '3' },
    document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 2, body: 'criteria' },
  });
  // Runner-facing projection must not leak upstream-only fields.
  assert.ok(!JSON.stringify(body).includes('hidden'));
});

test('read-only conditional GET rejects stale pins and every write without upstream access', async (t) => {
  let current = snapshot(), reads = 0;
  const request = await serve(t, { records: records(), readSnapshot: async () => { reads++; return current; } });
  const path = '/api/issues/OPE-123/acceptance-snapshot';
  const first = await request(path);
  const headers = { authorization: `Bearer ${token}`, 'if-match': first.headers.etag };
  assert.equal((await request(path, { headers })).status, 200);
  current = snapshot({ issue: { version: '4' } });
  assert.equal((await request(path, { headers })).status, 412);
  assert.equal((await request(path, { headers: { ...headers, 'if-match': '*' } })).status, 400);
  const before = reads;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await request(path, { method })).status, 404, method);
    assert.equal((await request(path + '/verify', { method, body: { secret: 'x' } })).status, 404, method);
  }
  assert.equal(reads, before);
});

test('revocation during upstream lookup fails closed and audit excludes request data', async (t) => {
  const mutable = records();
  const events = [];
  const request = await serve(t, {
    records: mutable,
    audit: async (event) => events.push(event),
    readSnapshot: async () => {
      mutable[0].revoked = true;
      return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: null };
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
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: null }),
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
    // The document property must be present and explicitly null or valid:
    // a missing property is a corrupted payload, not "no document".
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' } },
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: { id: 'doc-id' } },
    { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 0, body: 'criteria' } },
  ]) {
    const request = await serve(t, { records: records(), readSnapshot: async () => bad });
    // The pin path fails on the invalid upstream payload itself.
    const pinResult = await request('/api/issues/OPE-123/acceptance-snapshot');
    assert.equal(pinResult.status, 502, JSON.stringify(bad));
    assert.deepEqual(JSON.parse(pinResult.body), {});

  }
});

test('bigint generations and explicit null document survive projection', async (t) => {
  const current = { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '9007199254740993' }, document: null };
  const request = await serve(t, { records: records(), readSnapshot: async () => current });
  assert.deepEqual(JSON.parse((await request('/api/issues/OPE-123/acceptance-snapshot')).body), current);
});

test('read errors never return a partial mixed snapshot', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => { throw new Error('upstream read failed'); } });
  const pin = await request('/api/issues/OPE-123/acceptance-snapshot');
  assert.equal(pin.status, 502);
  assert.deepEqual(JSON.parse(pin.body), {});
});
