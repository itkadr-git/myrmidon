import { DatabaseSync } from 'node:sqlite';

// All replicas must use the same local SQLite database on a supported filesystem.
export function createReplayStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS claims (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL) STRICT');
  const claim = db.prepare('INSERT INTO claims (jti, expires) VALUES (?, ?) ON CONFLICT(jti) DO UPDATE SET expires = excluded.expires WHERE claims.expires <= ?');
  return {
    async claimOnce(jti, expires, now = Math.floor(Date.now() / 1000)) {
      if (typeof jti !== 'string' || !jti || jti.length > 256 || !Number.isSafeInteger(expires) || !Number.isSafeInteger(now) || expires <= now) throw new Error('invalid replay claim');
      return claim.run(jti, expires, now).changes === 1;
    },
    close() { db.close(); },
  };
}
