import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuthenticatedAudit } from './authenticated-audit.mjs';

test('anchor CAS rejection must fail the audit append closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-cas-'));
  const path = join(dir, 'audit.sqlite');
  const key = randomBytes(32);
  const anchor = { read: () => ({ seq: 0, mac: '' }), compareAndSet: () => false };
  try {
    const audit = createAuthenticatedAudit(path, key, anchor);
    await assert.rejects(audit.record('issued'), /anchor/);
    audit.close();
    const db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT count(*) AS count FROM audit_events').get().count, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an independently retained audit head rejects suffix deletion on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-anchor-'));
  const path = join(dir, 'audit.sqlite');
  const key = randomBytes(32);
  let head = { seq: 0, mac: '' };
  const anchor = {
    read: () => ({ ...head }),
    compareAndSet: (previous, next) => {
      if (JSON.stringify(head) !== JSON.stringify(previous)) throw new Error('anchor conflict');
      head = { ...next };
    },
  };
  try {
    const audit = createAuthenticatedAudit(path, key, anchor);
    await audit.record('issued');
    await audit.record('revoked');
    audit.close();
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM audit_events WHERE seq = 2');
    db.close();
    assert.throws(() => createAuthenticatedAudit(path, key, anchor), /audit integrity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
