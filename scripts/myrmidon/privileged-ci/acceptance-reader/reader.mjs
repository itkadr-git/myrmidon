import { createHash, timingSafeEqual } from 'node:crypto';

export function authenticate(header, records, now = Date.now()) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(header)) return null;
  const hash = createHash('sha256').update(header.slice(7)).digest();
  const matches = records.filter((record) => typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(record.tokenHash) && timingSafeEqual(hash, Buffer.from(record.tokenHash, 'hex')));
  if (matches.length !== 1) return null;
  const record = matches[0];
  return record.revoked === false && Number.isFinite(record.expiresAt) && now < record.expiresAt && typeof record.companyId === 'string' && record.companyId ? record.companyId : null;
}

const ISSUE = '(?:[A-Z][A-Z0-9]*-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PATH = new RegExp(`^/api/issues/(${ISSUE})(/documents/acceptance-scenarios)?$`);

export function parsePath(path) {
  const match = PATH.exec(path);
  return match ? { issue: match[1], document: Boolean(match[2]) } : null;
}
