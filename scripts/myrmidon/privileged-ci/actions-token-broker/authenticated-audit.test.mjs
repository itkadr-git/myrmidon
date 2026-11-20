import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuthenticatedAudit } from './authenticated-audit.mjs';

test('audit persists only allowlisted events and detects tampering across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'authenticated-audit-'));
  const path = join(dir, 'audit.sqlite');
  const key = randomBytes(32);
  try {
    let audit = createAuthenticatedAudit(path, key);
    await audit.record('issued');
    await assert.rejects(audit.record('secret-sentinel'));
    await audit.record('exchange_failed');
    audit.close();
    audit = createAuthenticatedAudit(path, key);
    await audit.record('revoked');
    audit.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE audit_events SET event = 'revoked' WHERE seq = 1");
    db.close();
    assert.throws(() => createAuthenticatedAudit(path, key), /audit integrity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
