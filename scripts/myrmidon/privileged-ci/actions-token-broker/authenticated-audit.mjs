import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const events = new Set(['issued', 'revoked', 'exchange_failed', 'revoke_failed']);

// The HMAC key must be distinct from the credential encryption key. Optional
// anchor is experimental: it must be an independently durable, synchronous CAS
// service. Without one, suffix deletion and rollback remain undetectable.
export function createAuthenticatedAudit(path, key, anchor) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:') || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid audit configuration');
  const secret = Buffer.from(key);
  const db = new DatabaseSync(path);
  function digest(seq, event, previous) {
    return createHmac('sha256', secret).update(JSON.stringify([seq, event, previous])).digest('hex');
  }
  function verify() {
    let previous = '', expected = 1;
    for (const row of db.prepare('SELECT seq, event, mac FROM audit_events ORDER BY seq').iterate()) {
      if (row.seq !== expected || !events.has(row.event) || typeof row.mac !== 'string' || !/^[0-9a-f]{64}$/.test(row.mac)) throw new Error('audit integrity failure');
      const calculated = digest(row.seq, row.event, previous);
      if (!timingSafeEqual(Buffer.from(row.mac, 'hex'), Buffer.from(calculated, 'hex'))) throw new Error('audit integrity failure');
      previous = row.mac;
      expected++;
    }
    return { previous, expected };
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS audit_events (seq INTEGER PRIMARY KEY, event TEXT NOT NULL, mac TEXT NOT NULL) STRICT');
    const { previous, expected } = verify();
    if (anchor && JSON.stringify(anchor.read()) !== JSON.stringify({ seq: expected - 1, mac: previous })) throw new Error('audit integrity failure: anchor mismatch');
  } catch (error) { db.close(); secret.fill(0); throw error; }
  return {
    async record(event) {
      if (!events.has(event)) throw new Error('invalid audit event');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { previous, expected } = verify();
        const oldHead = { seq: expected - 1, mac: previous };
        const newHead = { seq: expected, mac: digest(expected, event, previous) };
        if (anchor && JSON.stringify(anchor.read()) !== JSON.stringify(oldHead)) throw new Error('audit integrity failure: anchor mismatch');
        db.prepare('INSERT INTO audit_events VALUES (?, ?, ?)').run(expected, event, newHead.mac);
        // An interrupted cross-store update leaves a mismatch and fails closed.
        if (anchor && anchor.compareAndSet(oldHead, newHead) !== true) throw new Error('audit anchor update failed');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); secret.fill(0); },
  };
}
