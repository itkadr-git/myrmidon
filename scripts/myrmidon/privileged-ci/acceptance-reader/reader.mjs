import { createHash, timingSafeEqual } from 'node:crypto';

export function authenticate(header, records, now = Date.now()) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(header)) return null;
  const hash = createHash('sha256').update(header.slice(7)).digest();
  const matches = records.filter((record) => typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(record.tokenHash) && timingSafeEqual(hash, Buffer.from(record.tokenHash, 'hex')));
  if (matches.length !== 1) return null;
  const record = matches[0];
  return record.revoked === false && Number.isFinite(record.expiresAt) && now < record.expiresAt && typeof record.companyId === 'string' && record.companyId ? record.companyId : null;
}

function validSnapshot(value) {
  const issue = value?.issue;
  const doc = value?.document;
  return Boolean(issue && typeof issue.id === 'string' && typeof issue.identifier === 'string' &&
    typeof issue.companyId === 'string' && typeof issue.version === 'string' && /^\d+$/.test(issue.version) &&
    Object.hasOwn(value, 'document') && (doc === null || (doc && typeof doc.id === 'string' &&
    typeof doc.latestRevisionId === 'string' && doc.latestRevisionId && Number.isInteger(doc.latestRevisionNumber) &&
    doc.latestRevisionNumber > 0 && typeof doc.body === 'string')));
}

export function createHandler({ records, credentialStore, readSnapshot, audit = async () => {} }) {
  const checkCredential = (header) => credentialStore ? credentialStore.authenticate(header) : authenticate(header, records);
  return async (req, res) => {
    const authorizations = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length;
    const companyId = authorizations === 1 ? checkCredential(req.headers.authorization) : null;
    const respond = async (status, body = {}, etag) => {
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
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 200 && etag ? { etag } : {}) });
      res.end(JSON.stringify(body));
    };
    if (!companyId) return respond(401);
    const path = parsePath(req.url);
    if (req.method !== 'GET' || !path || Object.keys(req.headers).some((name) => name.includes('method-override') || name === 'x-http-method')) return respond(404);
    const matches = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'if-match').length;
    const match = req.headers['if-match'];
    if (matches > 1 || (matches === 1 && (typeof match !== 'string' || !/^"[A-Za-z0-9_-]+"$/.test(match)))) return respond(412);
    try {
      const snapshot = await readSnapshot(path.issue, match);
      if (snapshot === null) return respond(404);
      if (!validSnapshot(snapshot)) return respond(502);
      const { issue, document } = snapshot;
      if (issue.companyId !== companyId || (path.issue !== issue.id && path.issue !== issue.identifier)) return respond(404);
      if (match && (!document || match !== `"${document.latestRevisionId}"`)) return respond(412);
      if (!path.document) return respond(200, { identifier: issue.identifier, companyId: issue.companyId });
      if (!document) return respond(404);
      if (!/^[A-Za-z0-9_-]+$/.test(document.latestRevisionId)) return respond(502);
      const etag = `"${document.latestRevisionId}"`;
      return respond(200, { identifier: issue.identifier, companyId: issue.companyId, document: { id: document.id, revisionId: document.latestRevisionId, body: document.body } }, etag);
    } catch (error) {
      return respond(error?.code === 'PRECONDITION_FAILED' ? 412 : 502);
    }
  };
}

const ISSUE = '(?:[A-Z][A-Z0-9]*-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PATH = new RegExp(`^/api/issues/(${ISSUE})(/documents/acceptance-scenarios)?$`);

export function parsePath(path) {
  const match = PATH.exec(path);
  return match ? { issue: match[1], document: Boolean(match[2]) } : null;
}
