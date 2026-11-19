import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuthenticatedAudit } from './authenticated-audit.mjs';
import { createSqliteAnchor } from './sqlite-anchor.mjs';

test('durable separate anchor rejects audit suffix deletion after both stores restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-durable-'));
  const path = join(dir, 'audit.sqlite');
  const anchorPath = join(dir, 'anchor.sqlite');
  const key = randomBytes(32);
  try {
    let anchor = createSqliteAnchor(anchorPath);
    let audit = createAuthenticatedAudit(path, key, anchor);
    await audit.record('issued');
    await audit.record('revoked');
    audit.close();
    anchor.close();
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM audit_events WHERE seq = 2');
    db.close();
    anchor = createSqliteAnchor(anchorPath);
    assert.throws(() => createAuthenticatedAudit(path, key, anchor), /anchor mismatch/);
    anchor.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anchor CAS rejects stale writers and persists the winning head', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-cas-'));
  const path = join(dir, 'anchor.sqlite');
  const zero = { seq: 0, mac: '' };
  const first = { seq: 1, mac: 'a'.repeat(64) };
  try {
    const a = createSqliteAnchor(path);
    const b = createSqliteAnchor(path);
    assert.equal(a.compareAndSet(zero, first), true);
    assert.equal(b.compareAndSet(zero, { seq: 1, mac: 'b'.repeat(64) }), false);
    a.close(); b.close();
    const c = createSqliteAnchor(path);
    assert.deepEqual(c.read(), first);
    c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing anchor row is not silently recreated as a fresh genesis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-missing-'));
  const path = join(dir, 'anchor.sqlite');
  try {
    const anchor = createSqliteAnchor(path);
    assert.equal(anchor.compareAndSet({ seq: 0, mac: '' }, { seq: 1, mac: 'a'.repeat(64) }), true);
    anchor.close();
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM audit_anchor');
    db.close();
    assert.throws(() => createSqliteAnchor(path), /anchor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
