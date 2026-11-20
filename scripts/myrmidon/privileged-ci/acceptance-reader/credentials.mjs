import { authenticate } from './reader.mjs';

// Scope is copied once; the only supported mutation is irreversible revocation.
export function createCredentialStore(input) {
  if (!Array.isArray(input)) throw new TypeError('invalid credential records');
  const hashes = new Set();
  const records = input.map((record) => {
    if (!record || typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash) ||
        typeof record.companyId !== 'string' || !record.companyId ||
        !Number.isFinite(record.expiresAt) || typeof record.revoked !== 'boolean' || hashes.has(record.tokenHash)) {
      throw new TypeError('invalid credential record');
    }
    hashes.add(record.tokenHash);
    return { tokenHash: record.tokenHash, companyId: record.companyId, expiresAt: record.expiresAt, revoked: record.revoked };
  });
  return Object.freeze({
    authenticate: (header, now) => authenticate(header, records, now),
    revoke: (tokenHash) => {
      const record = records.find((entry) => entry.tokenHash === tokenHash);
      if (!record) return false;
      record.revoked = true;
      return true;
    },
  });
}
