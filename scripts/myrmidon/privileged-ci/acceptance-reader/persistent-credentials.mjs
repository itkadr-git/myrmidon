import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HASH = /^[a-f0-9]{64}$/;

// The directory must be private to the gateway operator and shared by all instances.
export function createPersistentCredentialStore(directory) {
  const path = (hash, suffix) => join(directory, `${hash}.${suffix}`);
  const revoked = (hash) => {
    try { statSync(path(hash, 'revoked')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  const persistExclusive = (file, contents) => {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  };
  return Object.freeze({
    issue(record) {
      if (!record || !HASH.test(record.tokenHash) || typeof record.companyId !== 'string' || !record.companyId || !Number.isFinite(record.expiresAt)) throw new TypeError('invalid credential record');
      if (revoked(record.tokenHash)) throw new Error('credential revoked');
      persistExclusive(path(record.tokenHash, 'json'), JSON.stringify({ tokenHash: record.tokenHash, companyId: record.companyId, expiresAt: record.expiresAt }));
    },
    revoke(hash) {
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new TypeError('invalid hash');
      try { persistExclusive(path(hash, 'revoked'), 'revoked'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    },
    authenticate(header, now = Date.now()) {
      try {
        if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(header)) return null;
        const hash = createHash('sha256').update(header.slice(7)).digest('hex');
        if (revoked(hash)) return null;
        const record = JSON.parse(readFileSync(path(hash, 'json'), 'utf8'));
        if (record.tokenHash !== hash || typeof record.companyId !== 'string' || !record.companyId || !Number.isFinite(record.expiresAt) || now >= record.expiresAt || revoked(hash)) return null;
        return record.companyId;
      } catch { return null; }
    },
  });
}
