import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpstream } from './upstream.mjs';

test('upstream rejects insecure, ambiguous and credential-bearing origins', () => {
  for (const origin of ['http://localhost:3100', 'https://user:pass@example.com', 'https://example.com/base', 'https://example.com/?x=1', 'https://example.com/#x']) {
    assert.throws(() => createUpstream({ origin, ca: 'ca', cert: 'cert', key: 'key' }), TypeError);
  }
  assert.throws(() => createUpstream({ origin: 'https://example.com', ca: 'ca' }), TypeError);
});

test('upstream denies malformed issue identity before network access', async () => {
  const upstream = createUpstream({ origin: 'https://127.0.0.1:1', ca: 'ca', cert: 'cert', key: 'key' });
  for (const id of ['../OPE-123', 'OPE-123?x=1', '%4fPE-123', 'OPE-123/extra']) {
    await assert.rejects(upstream.readIssue(id), TypeError);
    await assert.rejects(upstream.readDocument(id), TypeError);
  }
});
