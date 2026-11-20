import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';
import { createCredentialStore } from './store.mjs';
import { createSqliteAnchor, provisionSqliteAnchor } from './sqlite-anchor.mjs';

// Characterizes a remaining gap, not a successful containment test.
test('credential database rollback can lose a known token despite a matching audit anchor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-rollback-'));
  const credentials = join(dir, 'credentials.sqlite'), snapshot = join(dir, 'snapshot.sqlite');
  const auditPath = join(dir, 'audit.sqlite'), anchorPath = join(dir, 'anchor.sqlite');
  const credentialKey = randomBytes(32), auditKey = randomBytes(32);
  provisionSqliteAnchor(anchorPath);
  const anchor = createSqliteAnchor(anchorPath);
  try {
    let store = createCredentialStore(credentials, credentialKey);
    store.close();
    copyFileSync(credentials, snapshot);
    store = createCredentialStore(credentials, credentialKey);
    const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
    await store.reserveIssuance('attempt');
    await audit.record('issuance_pending');
    await store.put('handle', { token: 'fixture-value' }, 'owner');
    await audit.record('issued');
    await store.resolveIssuance('attempt');
    await audit.record('issuance_resolved');
    audit.close();
    store.close();
    copyFileSync(snapshot, credentials);
    store = createCredentialStore(credentials, credentialKey);
    try {
      const reopened = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
      reopened.close();
      assert.equal(store.hasRetainedCredentials(), false);
      assert.deepEqual(await store.pendingIssuances(), []);
      let revoked = 0;
      assert.deepEqual(await store.revokeRetained(async () => { revoked++; }), { revoked: 0, failed: 0 });
      assert.equal(revoked, 0);
    } finally { store.close(); }
  } finally { anchor.close(); rmSync(dir, { recursive: true, force: true }); }
});
