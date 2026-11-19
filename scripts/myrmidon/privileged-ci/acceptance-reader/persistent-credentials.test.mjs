import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPersistentCredentialStore } from './persistent-credentials.mjs';

const token = 'candidate-test-token-123456';
const tokenHash = createHash('sha256').update(token).digest('hex');
const record = { tokenHash, companyId: 'company-a', expiresAt: 2000 };

test('binding survives restart, cannot be replaced, and revocation is shared across instances', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'reader-credentials-'));
  try {
    const a = createPersistentCredentialStore(dir);
    a.issue(record);
    const b = createPersistentCredentialStore(dir);
    assert.equal(b.authenticate(`Bearer ${token}`, 1000), 'company-a');
    assert.throws(() => b.issue({ ...record, companyId: 'company-b' }));
    assert.equal(a.authenticate(`Bearer ${token}`, 1000), 'company-a');
    b.revoke(tokenHash);
    assert.equal(a.authenticate(`Bearer ${token}`, 1000), null);
    assert.equal(createPersistentCredentialStore(dir).authenticate(`Bearer ${token}`, 1000), null);
    assert.throws(() => a.issue(record));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expiry, malformed records and storage errors fail closed', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'reader-credentials-'));
  try {
    const store = createPersistentCredentialStore(dir);
    store.issue(record);
    assert.equal(store.authenticate(`Bearer ${token}`, 2000), null);
    writeFileSync(join(dir, `${tokenHash}.json`), '{');
    assert.equal(store.authenticate(`Bearer ${token}`, 1000), null);
    rmSync(dir, { recursive: true });
    assert.equal(store.authenticate(`Bearer ${token}`, 1000), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
