import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Single-host storage; the key must come from server-side secret management.
export function createCredentialStore(path, key) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:') || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid credential store configuration');
  const secret = Buffer.from(key);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS credentials (handle TEXT PRIMARY KEY, owner TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL) STRICT');
  const insert = db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT nonce, ciphertext, tag FROM credentials WHERE handle = ? AND owner = ?');
  const remove = db.prepare('DELETE FROM credentials WHERE handle = ? AND owner = ?');
  const removeHandle = db.prepare('DELETE FROM credentials WHERE handle = ?');
  let active = false;
  return {
    async put(handle, credential, owner) {
      if (active) throw new Error('store busy');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([handle, owner])));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
      insert.run(handle, owner, nonce, ciphertext, cipher.getAuthTag());
    },
    async delete(handle) {
      if (active) throw new Error('store busy');
      removeHandle.run(handle);
    },
    async withOwned(handle, owner, action) {
      if (active) throw new Error('store busy');
      active = true;
      let transaction = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        const row = select.get(handle, owner);
        if (!row) throw new Error('credential not found');
        const decipher = createDecipheriv('aes-256-gcm', secret, row.nonce);
        decipher.setAAD(Buffer.from(JSON.stringify([handle, owner])));
        decipher.setAuthTag(row.tag);
        const credential = JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
        await action(credential);
        remove.run(handle, owner);
        db.exec('COMMIT');
        transaction = false;
      } finally {
        if (transaction) db.exec('ROLLBACK');
        active = false;
      }
    },
    close() { db.close(); secret.fill(0); },
  };
}
