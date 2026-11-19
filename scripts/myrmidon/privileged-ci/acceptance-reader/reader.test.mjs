import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath } from './reader.mjs';

test('accepts only canonical issue and acceptance document paths', () => {
  assert.deepEqual(parsePath('/api/issues/OPE-123'), { issue: 'OPE-123', document: false });
  assert.deepEqual(parsePath('/api/issues/OPE-123/documents/acceptance-scenarios'), { issue: 'OPE-123', document: true });
  for (const path of ['/api/issues/OPE-123?x=1', '/api/issues/%4fPE-123', '/api/issues/OPE-123/', '/api/issues/OPE-123/documents/plan', '/api/issues/../OPE-123']) assert.equal(parsePath(path), null, path);
});
