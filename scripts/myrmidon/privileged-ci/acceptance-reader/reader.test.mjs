import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, authenticate, createHandler } from './reader.mjs';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createCredentialStore } from './credentials.mjs';

const token = 'candidate-test-token';
const hash = () => createHash('sha256').update(token).digest('hex');
const records = (companyId = 'company-a') => [{ tokenHash: hash(), companyId, expiresAt: Date.now() + 60000, revoked: false }];

const serve = async (t, handlerOptions) => {
  const server = createServer(createHandler(handlerOptions));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return (path, headers = { authorization: `Bearer ${token}` }) => new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
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

test('gateway projects a company-bound issue from the atomic snapshot and denies a foreign issue', async (t) => {
  const request = await serve(t, {
    records: records(),
    readSnapshot: async (ref) => ({
      issue: { id: 'OPE-123', identifier: 'OPE-123', companyId: ref === 'OPE-123' ? 'company-a' : 'company-b', secret: 'hidden' },
      document: { id: 'doc-id', latestRevisionId: 'rev-1', body: 'criteria', secret: 'hidden' },
    }),
  });
  const allowed = await request('/api/issues/OPE-123');
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), { id: 'OPE-123', identifier: 'OPE-123', companyId: 'company-a' });
  const denied = await request('/api/issues/OPE-124');
  assert.equal(denied.status, 404);
  assert.ok(!denied.body.includes('company-b'));
});

test('document response is the projected snapshot document with revision evidence from one upstream read', async (t) => {
  let reads = 0;
  const request = await serve(t, {
    records: records(),
    readSnapshot: async () => {
      reads += 1;
      return {
        issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' },
        document: { id: 'doc-id', latestRevisionId: 'rev-1', body: 'criteria', secret: 'hidden' },
      };
    },
  });
  const allowed = await request('/api/issues/OPE-123/documents/acceptance-scenarios');
  assert.equal(allowed.status, 200);
  assert.deepEqual(JSON.parse(allowed.body), { id: 'doc-id', latestRevisionId: 'rev-1', body: 'criteria' });
  assert.equal(reads, 1);
});

test('a snapshot document is withheld when its tenant differs from the credential', async (t) => {
  const request = await serve(t, {
    records: records(),
    readSnapshot: async () => ({
      issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-b' },
      document: { id: 'doc-id', latestRevisionId: 'rev-1', body: 'criteria' },
    }),
  });
  const result = await request('/api/issues/OPE-123/documents/acceptance-scenarios');
  assert.equal(result.status, 404);
  assert.ok(!result.body.includes('criteria'));
});

test('document is never returned when the snapshot omits it or its identity is malformed', async (t) => {
  for (const document of [null, { id: 'doc-id' }, { id: 'doc-id', latestRevisionId: '', body: 'criteria' }, { id: 'doc-id', latestRevisionId: 'rev-1' }]) {
    const request = await serve(t, {
      records: records(),
      readSnapshot: async () => ({
        issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' },
        document,
      }),
    });
    const result = await request('/api/issues/OPE-123/documents/acceptance-scenarios');
    assert.equal(result.status, 404, JSON.stringify(document));
    assert.ok(!result.body.includes('criteria'));
  }
});

test('read errors never return a partial mixed snapshot', async (t) => {
  const request = await serve(t, { records: records(), readSnapshot: async () => { throw new Error('upstream read failed'); } });
  const issue = await request('/api/issues/OPE-123');
  const document = await request('/api/issues/OPE-123/documents/acceptance-scenarios');
  assert.equal(issue.status, 502);
  assert.equal(document.status, 502);
  assert.deepEqual(JSON.parse(issue.body), {});
  assert.deepEqual(JSON.parse(document.body), {});
});

test('revocation during upstream lookup fails closed and audit excludes request data', async (t) => {
  const mutable = records();
  const events = [];
  const request = await serve(t, {
    records: mutable,
    audit: async (event) => events.push(event),
    readSnapshot: async () => {
      mutable[0].revoked = true;
      return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' }, document: null };
    },
  });
  const result = await request('/api/issues/OPE-123');
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
    readSnapshot: async () => { reads += 1; return { issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' }, document: null }; },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port: server.address().port, path: '/api/issues/OPE-123', headers: ['Host', 'localhost', 'Authorization', `Bearer ${token}`, 'Authorization', 'Bearer another-candidate-token'] }, (res) => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  }).on('error', reject));
  assert.equal(status, 401);
  assert.equal(reads, 0);
});

test('rejects a snapshot issue that does not match the requested identifier', async (t) => {
  const request = await serve(t, {
    records: records(),
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-999', companyId: 'company-a' }, document: null }),
  });
  const result = await request('/api/issues/OPE-123');
  assert.equal(result.status, 404);
});

test('handler accepts the immutable credential store and observes revocation', async (t) => {
  const store = createCredentialStore(records());
  const request = await serve(t, {
    credentialStore: store,
    readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a' }, document: null }),
  });
  assert.equal((await request('/api/issues/OPE-123')).status, 200);
  store.revoke(hash());
  assert.equal((await request('/api/issues/OPE-123')).status, 401);
});

test('accepts only canonical issue and acceptance document paths', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123'), { issue: 'OPE-123', document: false });
  assert.deepEqual(parsePath('/api/issues/OPE-123/documents/acceptance-scenarios'), { issue: 'OPE-123', document: true });
  for (const path of ['/api/issues/OPE-123?x=1', '/api/issues/%4fPE-123', '/api/issues/OPE-123/', '/api/issues/OPE-123/documents/plan', '/api/issues/../OPE-123', '/api/issues/OPE-123/acceptance-scenarios-snapshot']) assert.equal(parsePath(path), null, path);
});
