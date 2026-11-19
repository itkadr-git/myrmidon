import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, authenticate, createHandler } from './reader.mjs';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCredentialStore } from './credentials.mjs';

test('credential binding rejects expired revoked and wrong bearer', () => {
  const token = 'candidate-test-token';
  const record = { tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.equal(authenticate(`Bearer ${token}`, [record], 1000), 'company-a');
  assert.equal(authenticate('Bearer wrong', [record], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [{ ...record, revoked: true }], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [record], 2000), null);
  assert.equal(authenticate(undefined, [record], 1000), null);
});

test('duplicate credential records fail closed, even when one is revoked or has another company', () => {
  const token = 'candidate-test-token';
  const record = { tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.equal(authenticate(`Bearer ${token}`, [record, { ...record, revoked: true }], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [record, { ...record, companyId: 'company-b' }], 1000), null);
});

test('gateway projects a company-bound issue and denies foreign issue', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  const server = createServer(createHandler({ records, readSnapshot: async (id) => ({ issue: { id, identifier: 'OPE-123', companyId: id === 'OPE-123' ? 'company-a' : 'company-b', version: '1', secret: 'hidden' }, document: null }) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const request = (path) => new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: server.address().port, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  const allowed = await request('/api/issues/OPE-123');
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), { identifier: 'OPE-123', companyId: 'company-a' });
  const denied = await request('/api/issues/OPE-124');
  assert.equal(denied.status, 404);
  assert.ok(!denied.body.includes('company-b'));
});

test('document response is company-bound, projected and rejects a changing revision', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  let reads = 0;
  let change = false;
  const server = createServer(createHandler({ records,
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: change ? String(++reads) : '1' }, document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 1, body: 'criteria', secret: 'hidden' } }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const request = () => new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123/documents/acceptance-scenarios', headers: { authorization: `Bearer ${token}` } }, (res) => {
    let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  const allowed = await request();
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), { id: 'doc-id', latestRevisionId: 'rev-1', body: 'criteria' });
  change = true;
  assert.equal((await request()).status, 409);
});

test('document is withheld on an ABA change even when the visible issue and revision return to their original values', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  let version = 1;
  const server = createServer(createHandler({ records,
    readSnapshot: async () => {
      const snapshot = { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: String(version) }, document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 1, body: 'criteria' } };
      version = 3; // A -> B -> A preserves visible content but advances the epoch.
      return snapshot;
    },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const result = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123/documents/acceptance-scenarios', headers: { authorization: `Bearer ${token}` } }, (res) => {
    let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  assert.equal(result.status, 409);
  assert.ok(!result.body.includes('criteria'));
});

test('revocation during upstream lookup fails closed and audit excludes request data', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  const events = [];
  const server = createServer(createHandler({ records, audit: async (event) => events.push(event), readSnapshot: async () => {
    records[0].revoked = true;
    return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1', secret: 'hidden' }, document: null };
  } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const result = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123', headers: { authorization: `Bearer ${token}` } }, (res) => {
    let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  assert.equal(result.status, 401);
  assert.ok(!result.body.includes('issue-id'));
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(token));
  assert.ok(!JSON.stringify(events).includes('hidden'));
});

test('document is withheld when the issue changes company during lookup', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  let reads = 0;
  const server = createServer(createHandler({ records,
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: ++reads === 1 ? 'company-a' : 'company-b', version: String(reads) }, document: { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 1, body: 'criteria' } }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const result = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123/documents/acceptance-scenarios', headers: { authorization: `Bearer ${token}` } }, (res) => {
    let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
  assert.notEqual(result.status, 200);
  assert.ok(!result.body.includes('criteria'));
});

test('malformed snapshot documents are never returned', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  let document;
  const server = createServer(createHandler({ records,
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  for (const change of [{ id: null }, { latestRevisionId: null }, { latestRevisionNumber: 0 }]) {
    document = { id: 'doc-id', latestRevisionId: 'rev-1', latestRevisionNumber: 1, body: 'private-criteria', ...change };
    const result = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123/documents/acceptance-scenarios', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject));
    assert.equal(result.status, 502);
    assert.ok(!result.body.includes('private-criteria'));
  }
});

test('duplicate authorization headers are rejected before upstream access', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  let reads = 0;
  const server = createServer(createHandler({ records, readSnapshot: async () => {
    reads++;
    return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: null };
  } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123', headers: ['Host', 'localhost', 'Authorization', `Bearer ${token}`, 'Authorization', 'Bearer another-candidate-token'] }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).on('error', reject));
  assert.equal(status, 401);
  assert.equal(reads, 0);
});

test('rejects an upstream issue that does not match the requested identifier', async (t) => {
  const token = 'candidate-test-token';
  const records = [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }];
  const server = createServer(createHandler({ records, readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-999', companyId: 'company-a', version: '1' }, document: null }) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123', headers: { authorization: `Bearer ${token}` } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).on('error', reject));
  assert.equal(status, 404);
});

test('handler accepts the immutable credential store and observes revocation', async (t) => {
  const token = 'candidate-test-token';
  const hash = createHash('sha256').update(token).digest('hex');
  const store = createCredentialStore([{ tokenHash: hash, companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }]);
  const server = createServer(createHandler({ credentialStore: store, readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1' }, document: null }) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const request = () => new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123', headers: { authorization: `Bearer ${token}` } }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).on('error', reject));
  assert.equal(await request(), 200);
  store.revoke(hash);
  assert.equal(await request(), 401);
});

test('accepts only canonical issue and acceptance document paths', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123'), { issue: 'OPE-123', document: false });
  assert.deepEqual(parsePath('/api/issues/OPE-123/documents/acceptance-scenarios'), { issue: 'OPE-123', document: true });
  for (const path of ['/api/issues/OPE-123?x=1', '/api/issues/%4fPE-123', '/api/issues/OPE-123/', '/api/issues/OPE-123/documents/plan', '/api/issues/../OPE-123']) assert.equal(parsePath(path), null, path);
});
