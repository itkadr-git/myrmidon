import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from './broker.mjs';

test('identity dependency failure emits a fixed audit event and redacts the public error', async () => {
  const events = [];
  const broker = createBroker({ policy: {}, loadKeys: async () => { throw new Error('private-sentinel'); }, claimOnce: async () => true, installation: {}, store: {}, audit: async event => events.push(event) });
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.AA`;
  await assert.rejects(broker.exchange(jwt), error => error.message === 'broker request failed');
  assert.deepEqual(events, ['exchange_failed']);
  assert.equal(JSON.stringify(events).includes('private-sentinel'), false);
});
