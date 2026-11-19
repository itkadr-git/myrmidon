import { DatabaseSync } from 'node:sqlite';

// Hold a separate SQLite write transaction for the full broker lifetime.
export function acquireExclusiveStore(path) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:')) throw new Error('persistent credential path required');
  const db = new DatabaseSync(`${path}.owner.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error('exclusive store ownership unavailable');
  }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
