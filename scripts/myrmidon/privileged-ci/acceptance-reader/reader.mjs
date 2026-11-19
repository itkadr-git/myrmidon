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

export function isIssueIdentity(value) {
  return typeof value === 'string' && new RegExp(`^${ISSUE}$`).test(value);
}

// The gateway answers both of its runner-facing routes from ONE upstream read:
// the atomic acceptance snapshot (a single SQL statement upstream), never from
// two independent reads that could observe different moments. The stored
// credential's company is checked against the snapshot before anything is
// returned, and credential revocation is re-checked immediately before the
// response, so revocation or expiry during the upstream read fails closed.
export function createHandler({ records, credentialStore, readSnapshot, audit = async () => {} }) {
  const checkCredential = (header) => credentialStore ? credentialStore.authenticate(header) : authenticate(header, records);
  return async (req, res) => {
    const authorizations = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length;
    const companyId = authorizations === 1 ? checkCredential(req.headers.authorization) : null;
    const respond = async (status, body = {}) => {
      if (status === 200 && checkCredential(req.headers.authorization) !== companyId) {
        status = 401;
        body = {};
      }
      try {
        await audit({ status });
      } catch {
        status = 503;
        body = {};
      }
      if (status === 200 && checkCredential(req.headers.authorization) !== companyId) {
        status = 401;
        body = {};
      }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!companyId) return respond(401);
    const path = parsePath(req.url);
    if (req.method !== 'GET' || !path || Object.keys(req.headers).some((name) => name.includes('method-override') || name === 'x-http-method')) return respond(404);
    try {
      const snapshot = await readSnapshot(path.issue);
      // Upstream not-found: the identical 404 for foreign and unknown issues.
      if (snapshot === null || snapshot === undefined) return respond(404);
      const issue = snapshot.issue;
      const document = snapshot.document;
      // A 200 payload that does not match the snapshot contract is an
      // upstream malfunction, not "not found": fail closed with 502 before
      // anything is projected, whatever route was requested.
      const validIssue = issue && typeof issue.id === 'string' && typeof issue.identifier === 'string' && typeof issue.companyId === 'string';
      const validDocument = document === null || document === undefined || (
        typeof document.id === 'string' && typeof document.latestRevisionId === 'string' && document.latestRevisionId && typeof document.body === 'string'
      );
      if (!validIssue || !validDocument) return respond(502);
      // Fail closed on anything that does not match the credential's company
      // and the requested identity; unknown and foreign are the same 404.
      if (issue.companyId !== companyId || (path.issue !== issue.id && path.issue !== issue.identifier)) return respond(404);
      if (!path.document) return respond(200, { id: issue.id, identifier: issue.identifier, companyId: issue.companyId });
      // A valid snapshot may carry no document yet; that is the 404 case.
      if (document === null || document === undefined) return respond(404);
      return respond(200, { id: document.id, latestRevisionId: document.latestRevisionId, body: document.body });
    } catch {
      // A failed upstream read never yields a partial or mixed snapshot.
      return respond(502);
    }
  };
}
