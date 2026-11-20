import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCredentialStore } from './credentials.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

test('credential scope is copied and immutable while revocation fails closed', () => {
  const token = 'candidate-test-token';
  const record = { tokenHash: hash(token), companyId: 'company-a', expiresAt: 2000, revoked: false };
  const store = createCredentialStore([record]);
  record.companyId = 'company-b';
  record.revoked = true;
  assert.equal(store.authenticate(`Bearer ${token}`, 1000), 'company-a');
  store.revoke(record.tokenHash);
  assert.equal(store.authenticate(`Bearer ${token}`, 1000), null);
  assert.equal(store.authenticate(`Bearer ${token}`, 2000), null);
});

test('duplicate or malformed scope records are rejected at construction', () => {
  const record = { tokenHash: hash('candidate-test-token'), companyId: 'company-a', expiresAt: 2000, revoked: false };
  assert.throws(() => createCredentialStore([record, { ...record, companyId: 'company-b' }]));
  assert.throws(() => createCredentialStore([{ ...record, companyId: '' }]));
  assert.throws(() => createCredentialStore([{ ...record, expiresAt: NaN }]));
});
