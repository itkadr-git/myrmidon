import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerApi } from './runner-api.mjs';

test('claim, report and ownership receipts use scoped executor endpoints', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = createRunnerApi({ baseUrl: 'https://board.example/', companyId: 'company', token: 'secret', fetch });
  await api.claim();
  await api.report('job', { step: 'connect', result: 'ok' });
  await api.recordOwnedResource('job', { kind: 'ssh_key', id: 'key' });
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), [
    '/api/myrmidon/fleet/onboard-jobs/claim',
    '/api/myrmidon/fleet/onboard-jobs/job/report',
    '/api/myrmidon/fleet/onboard-jobs/job/owned-resources',
  ]);
  assert.ok(calls.every(c => c.headers['x-onboard-token'] === 'secret' && c.body.companyId === 'company'));
  assert.deepEqual(calls[2].body.resource, { kind: 'ssh_key', id: 'key' });
});

test('empty queue returns null and server errors never expose response secrets', async () => {
  const api = createRunnerApi({ baseUrl: 'https://board.example', companyId: 'company', token: 'secret', fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await api.claim(), null);
  const failing = createRunnerApi({ baseUrl: 'https://board.example', companyId: 'company', token: 'secret', fetch: async () => new Response('secret password', { status: 500 }) });
  await assert.rejects(failing.claim(), error => error.message === 'Fleet onboarding API returned HTTP 500');
});

test('rejects cleartext remote board URLs and report company override', async () => {
  assert.throws(() => createRunnerApi({ baseUrl: 'http://remote.example', companyId: 'company', token: 'secret' }), /HTTPS/);
  const api = createRunnerApi({ baseUrl: 'https://board.example', companyId: 'company', token: 'secret', fetch: async () => new Response('{}') });
  await assert.rejects(api.report('job', { companyId: 'other' }), /companyId/);
});
