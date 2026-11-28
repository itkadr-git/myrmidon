import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from './http.mjs';

async function invoke(handler, { path = '/exchange', body = {}, authorized = true, method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url: path, method, socket: { encrypted: true, authorized } });
  let status, headers, output;
  const res = { writeHead: (s, h) => { status = s; headers = h; }, end: value => { output = value; } };
  await handler(req, res);
  return { status, headers, body: JSON.parse(output) };
}

test('HTTP boundary requires client authentication and never exposes errors', async () => {
  const calls = [];
  const handler = createHandler({ exchange: async jwt => { calls.push(jwt); return { handle: 'h', token: 'fixture', expiresAt: '2030-01-01T00:00:00Z' }; }, revoke: async () => { throw new Error('sensitive internal error'); } });
  assert.equal((await invoke(handler, { authorized: false, body: { jwt: 'identity' } })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await invoke(handler, { body: { jwt: 'identity', permissions: { admin: 'write' } } })).status, 400);
  const ok = await invoke(handler, { body: { jwt: 'identity' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.body.token, 'fixture');
  assert.deepEqual(calls, ['identity']);
  const failed = await invoke(handler, { path: '/revoke', body: { jwt: 'identity', handle: 'h' } });
  assert.equal(failed.status, 403);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
  assert.equal((await invoke(handler, { path: '/other' })).status, 404);
});
