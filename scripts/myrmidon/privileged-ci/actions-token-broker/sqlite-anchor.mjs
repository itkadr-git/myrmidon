import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';

// Provisioning is a separate operator action, never a startup fallback.
export function provisionSqliteAnchor(path) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:')) throw new Error('invalid anchor path');
  closeSync(openSync(path, 'wx', 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; CREATE TABLE audit_anchor (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), seq INTEGER NOT NULL, mac TEXT NOT NULL) STRICT; INSERT INTO audit_anchor VALUES (1, 0, ''); COMMIT");
  } finally { db.close(); }
}

// This store is independent only if deployed in a separate protected failure domain.
export function createSqliteAnchor(path) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:')) throw new Error('invalid anchor path');
  let db;
  try { closeSync(openSync(path, 'r+')); db = new DatabaseSync(path); }
  catch { throw new Error('provisioned audit anchor missing or inaccessible'); }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_anchor'").get();
    if (!exists || !db.prepare('SELECT 1 FROM audit_anchor WHERE singleton = 1').get()) {
      throw new Error('provisioned audit anchor missing');
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  return {
    read() {
      const row = db.prepare('SELECT seq, mac FROM audit_anchor WHERE singleton = 1').get();
      if (!row || !Number.isSafeInteger(row.seq) || row.seq < 0 || (row.seq === 0 ? row.mac !== '' : !/^[0-9a-f]{64}$/.test(row.mac))) throw new Error('invalid anchor head');
      return { seq: row.seq, mac: row.mac };
    },
    compareAndSet(previous, next) {
      if (!Number.isSafeInteger(previous?.seq) || !Number.isSafeInteger(next?.seq) || next.seq !== previous.seq + 1 || typeof previous.mac !== 'string' || !/^[0-9a-f]{64}$/.test(next.mac)) throw new Error('invalid anchor transition');
      return db.prepare('UPDATE audit_anchor SET seq = ?, mac = ? WHERE singleton = 1 AND seq = ? AND mac = ?').run(next.seq, next.mac, previous.seq, previous.mac).changes === 1;
    },
    close() { db.close(); },
  };
}
