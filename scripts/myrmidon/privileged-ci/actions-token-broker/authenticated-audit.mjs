import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const events = new Set(['issued', 'revoked', 'exchange_failed', 'revoke_failed', 'issuance_ambiguous', 'issuance_pending', 'issuance_resolved']);

export class PendingIssuanceError extends Error {}

// Async CAS permits an anchor in a separately operated failure domain.
export async function createAsyncAuthenticatedAudit(path, key, anchor) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:') || !Buffer.isBuffer(key) || key.length !== 32 || typeof anchor?.read !== 'function' || typeof anchor?.compareAndSet !== 'function') throw new Error('invalid audit configuration');
  const secret = Buffer.from(key), db = new DatabaseSync(path);
  let pendingWrites = 0, failed = false, closed = false;
  let queue = Promise.resolve();
  function digest(seq, event, previous) {
    return createHmac('sha256', secret).update(JSON.stringify([seq, event, previous])).digest('hex');
  }
  function verify() {
    let previous = '', expected = 1, pending = false;
    for (const row of db.prepare('SELECT seq, event, mac FROM audit_events ORDER BY seq').iterate()) {
      if (row.seq !== expected || !events.has(row.event) || typeof row.mac !== 'string' || !/^[0-9a-f]{64}$/.test(row.mac) || !timingSafeEqual(Buffer.from(row.mac, 'hex'), Buffer.from(digest(row.seq, row.event, previous), 'hex'))) throw new Error('audit integrity failure');
      if (row.event === 'issuance_pending') {
        if (pending) throw new Error('audit integrity failure: duplicate pending issuance');
        pending = true;
      } else if (row.event === 'issuance_resolved') {
        if (!pending) throw new Error('audit integrity failure: missing pending issuance');
        pending = false;
      }
      previous = row.mac;
      expected++;
    }
    return { seq: expected - 1, mac: previous, pending };
  }
  const equal = (a, b) => a?.seq === b.seq && a?.mac === b.mac;
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS audit_events (seq INTEGER PRIMARY KEY, event TEXT NOT NULL, mac TEXT NOT NULL) STRICT');
    const head = verify();
    if (!equal(await anchor.read(), head)) throw new Error('audit integrity failure: anchor mismatch');
    if (head.pending) throw new PendingIssuanceError('pending issuance requires operator containment');
  } catch (error) { db.close(); secret.fill(0); throw error; }
  return {
    async record(event) {
      if (!events.has(event) || closed) throw new Error('invalid audit event');
      pendingWrites++;
      const write = queue.then(async () => {
        if (failed) throw new Error('audit unavailable');
        let transaction = false;
        try {
          db.exec('BEGIN IMMEDIATE');
          transaction = true;
          const verified = verify();
          if ((event === 'issuance_pending' && verified.pending) || (event === 'issuance_resolved' && !verified.pending)) throw new Error('invalid issuance audit transition');
          const oldHead = { seq: verified.seq, mac: verified.mac };
          if (!equal(await anchor.read(), oldHead)) throw new Error('audit integrity failure: anchor mismatch');
          const next = { seq: oldHead.seq + 1, mac: digest(oldHead.seq + 1, event, oldHead.mac) };
          db.prepare('INSERT INTO audit_events VALUES (?, ?, ?)').run(next.seq, event, next.mac);
          // CAS before commit: a lost response or crash leaves a mismatch, never silent rollback.
          if (await anchor.compareAndSet(oldHead, next) !== true) throw new Error('audit anchor update failed');
          db.exec('COMMIT');
          transaction = false;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (transaction) db.exec('ROLLBACK');
        }
      });
      queue = write.catch(() => {});
      try { await write; } finally { pendingWrites--; }
    },
    close() { if (pendingWrites) throw new Error('audit busy'); closed = true; db.close(); secret.fill(0); },
  };
}

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
