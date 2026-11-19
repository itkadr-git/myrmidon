import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Hold a separate SQLite write transaction for the full broker lifetime.
export function acquireExclusiveStore(path) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:')) throw new Error('persistent credential path required');
  const canonical = join(realpathSync(dirname(path)), basename(path));
  try {
    const stat = lstatSync(canonical);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('exclusive store ownership unavailable');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(`${canonical}.owner.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch {
    db.close();
    throw new Error('exclusive store ownership unavailable');
  }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
