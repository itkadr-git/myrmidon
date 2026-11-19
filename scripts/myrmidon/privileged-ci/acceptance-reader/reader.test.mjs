import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, authenticate } from './reader.mjs';
import { createHash } from 'node:crypto';

test('credential binding rejects expired revoked and wrong bearer', () => {
  const token = 'candidate-test-token';
  const record = { tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.equal(authenticate(`Bearer ${token}`, [record], 1000), 'company-a');
  assert.equal(authenticate('Bearer wrong', [record], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [{ ...record, revoked: true }], 1000), null);
  assert.equal(authenticate(`Bearer ${token}`, [record], 2000), null);
  assert.equal(authenticate(undefined, [record], 1000), null);
});

test('accepts only canonical issue and acceptance document paths', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123'), { issue: 'OPE-123', document: false });
  assert.deepEqual(parsePath('/api/issues/OPE-123/documents/acceptance-scenarios'), { issue: 'OPE-123', document: true });
  for (const path of ['/api/issues/OPE-123?x=1', '/api/issues/%4fPE-123', '/api/issues/OPE-123/', '/api/issues/OPE-123/documents/plan', '/api/issues/../OPE-123']) assert.equal(parsePath(path), null, path);
});
