import { test } from 'node:test';

test('a stalled issuance request is aborted and treated as ambiguous', async () => {
  let aborted = false;
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture', requestTimeoutMs: 10, request: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  await assert.rejects(client.issue(), /aborted/);
  assert.equal(aborted, true);
});
import assert from 'node:assert/strict';
import { createInstallationClient } from './installation.mjs';

test('a valid upstream token is retained before issuance returns', async () => {
  const events = [];
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture', request: async () => ({ ok: true, json: async () => ({ token: 'known-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'read' }, repositories: [{ id: 123 }] }) }) });
  const result = await client.issue(async token => { events.push(`retained:${token}`); });
  events.push(`returned:${result.token}`);
  assert.deepEqual(events, ['retained:known-fixture', 'returned:known-fixture']);
});

test('valid token retention failure attempts revocation without returning the token', async () => {
  const calls = [];
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'fixture', request: async (_url, options) => {
    calls.push(options.method);
    if (options.method === 'DELETE') throw new Error('revoke offline');
    return { ok: true, json: async () => ({ token: 'known-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'read' }, repositories: [{ id: 123 }] }) };
  } });
  await assert.rejects(client.issue(async () => { throw new Error('store offline'); }), /store offline/);
  assert.deepEqual(calls, ['POST', 'DELETE']);
});

test('server policy rejects permissions outside the prototype read-only profile', () => {
  for (const permissions of [{ administration: 'write' }, { contents: 'write' }, { issues: 'read' }]) {
    assert.throws(() => createInstallationClient({ installationId: '42', repositoryId: 123, permissions, appJwt: async () => 'fixture' }), /invalid installation policy/);
  }
});

test('installation issuance uses only the configured repository and permissions', async () => {
  const calls = [];
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'app-fixture', request: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ token: 'issued-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'read', metadata: 'read' }, repositories: [{ id: 123 }] }) };
  } });
  const token = await client.issue();
  assert.equal(token.token, 'issued-fixture');
  assert.equal(calls[0].url, 'https://api.github.com/app/installations/42/access_tokens');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { repository_ids: [123], permissions: { contents: 'read' } });
  await client.revoke(token.token);
  assert.equal(calls[1].url, 'https://api.github.com/installation/token');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.headers.authorization, 'Bearer issued-fixture');
});

test('rejects and revokes an upstream token with expanded permissions', async () => {
  const calls = [];
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions: { contents: 'read' }, appJwt: async () => 'app-fixture', request: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'DELETE') return { ok: true };
    return { ok: true, json: async () => ({ token: 'unsafe-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' }, repositories: [{ id: 123 }] }) };
  } });
  await assert.rejects(client.issue());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'DELETE');
});

test('later policy mutation cannot expand accepted upstream permissions', async () => {
  const permissions = { contents: 'read' };
  const calls = [];
  const client = createInstallationClient({ installationId: '42', repositoryId: 123, permissions, appJwt: async () => 'app-fixture', request: async (url, init) => {
    calls.push(init.method);
    if (init.method === 'DELETE') return { ok: true };
    return { ok: true, json: async () => ({ token: 'unsafe-fixture', expires_at: '2030-01-01T00:00:00Z', permissions: { contents: 'write' }, repositories: [{ id: 123 }] }) };
  } });
  permissions.contents = 'write';
  await assert.rejects(client.issue());
  assert.deepEqual(calls, ['POST', 'DELETE']);
});
