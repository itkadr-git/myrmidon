import { createHash, timingSafeEqual } from 'node:crypto';

export function authenticate(header, records, now = Date.now()) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(header)) return null;
  const hash = createHash('sha256').update(header.slice(7)).digest();
  const matches = records.filter((record) => typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(record.tokenHash) && timingSafeEqual(hash, Buffer.from(record.tokenHash, 'hex')));
  if (matches.length !== 1) return null;
  const record = matches[0];
  return record.revoked === false && Number.isFinite(record.expiresAt) && now < record.expiresAt && typeof record.companyId === 'string' && record.companyId ? record.companyId : null;
}

export function createHandler({ records, credentialStore, readIssue, readDocument, audit = async () => {} }) {
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
      const issue = await readIssue(path.issue);
      if (!issue || issue.companyId !== companyId || typeof issue.id !== 'string' || typeof issue.identifier !== 'string' || (path.issue !== issue.id && path.issue !== issue.identifier)) return respond(404);
      if (!path.document) return respond(200, { id: issue.id, identifier: issue.identifier, companyId: issue.companyId });
      const first = await readDocument(issue.id);
      const valid = (doc) => doc && doc.issueId === issue.id && doc.companyId === companyId && doc.key === 'acceptance-scenarios' && typeof doc.id === 'string' && typeof doc.latestRevisionId === 'string' && doc.latestRevisionId && typeof doc.body === 'string';
      if (!valid(first)) return respond(404);
      const second = await readDocument(issue.id);
      if (!valid(second) || first.id !== second.id || first.latestRevisionId !== second.latestRevisionId || first.body !== second.body) return respond(409);
      const currentIssue = await readIssue(issue.id);
      if (!currentIssue || currentIssue.id !== issue.id || currentIssue.identifier !== issue.identifier || currentIssue.companyId !== companyId) return respond(409);
      return respond(200, { id: first.id, latestRevisionId: first.latestRevisionId, body: first.body });
    } catch {
      return respond(502);
    }
  };
}

const ISSUE = '(?:[A-Z][A-Z0-9]*-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PATH = new RegExp(`^/api/issues/(${ISSUE})(/documents/acceptance-scenarios)?$`);

export function parsePath(path) {
  const match = PATH.exec(path);
  return match ? { issue: match[1], document: Boolean(match[2]) } : null;
}
