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
const PIN_PATH = new RegExp(`^/api/issues/(${ISSUE})/acceptance-snapshot$`);

export function parsePath(path) {
  const match = PIN_PATH.exec(path);
  return match ? { issue: match[1] } : null;
}

export function isIssueIdentity(value) {
  return typeof value === 'string' && new RegExp(`^${ISSUE}$`).test(value);
}

function validIssue(issue) {
  // version is a decimal bigint string: exact beyond 2^53, where JS numbers
  // collapse adjacent generations.
  return Boolean(issue) && typeof issue.id === 'string' && typeof issue.identifier === 'string' &&
    typeof issue.companyId === 'string' && typeof issue.version === 'string' && /^\d+$/.test(issue.version);
}

function validDocument(document) {
  // Strictly the explicit null or a complete valid object: undefined is a
  // malformed payload, never silently "no document".
  if (document === null) return true;
  if (typeof document !== 'object') return false;
  return typeof document.id === 'string' && typeof document.latestRevisionId === 'string' && document.latestRevisionId &&
    Number.isInteger(document.latestRevisionNumber) && document.latestRevisionNumber > 0 &&
    typeof document.body === 'string';
}

function validSnapshot(snapshot) {
  // Strict schema: the document property must be present and explicitly
  // null or valid — a missing property is a corrupted payload, never
  // silently "no document".
  return Boolean(snapshot) && validIssue(snapshot.issue) &&
    Object.prototype.hasOwnProperty.call(snapshot, 'document') &&
    validDocument(snapshot.document);
}

function snapshotEtag(snapshot) {
  return `"${createHash('sha256').update(JSON.stringify([
    snapshot.issue.id, snapshot.issue.version, snapshot.document?.latestRevisionId ?? null,
  ])).digest('hex')}"`;
}

// The minimal runner-facing projection of a valid snapshot: exactly the pin
// fields, never upstream-only data.
function project(snapshot) {
  return {
    issue: {
      id: snapshot.issue.id,
      identifier: snapshot.issue.identifier,
      companyId: snapshot.issue.companyId,
      version: snapshot.issue.version,
    },
    document: snapshot.document == null ? null : {
      id: snapshot.document.id,
      latestRevisionId: snapshot.document.latestRevisionId,
      latestRevisionNumber: snapshot.document.latestRevisionNumber,
      body: snapshot.document.body,
    },
  };
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
    const etag = req.headers['if-match'];
    if (etag !== undefined && !/^"[a-f0-9]{64}"$/.test(etag)) return respond(400);
    try {
      let snapshot;
      try {
        snapshot = await readSnapshot(path.issue, etag);
      } catch (error) {
        if (error?.status === 412 && etag) return respond(412);
        throw error;
      }
      // Upstream not-found: the identical 404 for foreign and unknown issues.
      if (snapshot === null || snapshot === undefined) return respond(404);
      // A 200 payload that does not match the snapshot contract is an
      // upstream malfunction, not "not found": fail closed with 502 before
      // anything is projected.
      if (!validSnapshot(snapshot)) return respond(502);
      // Fail closed on anything that does not match the credential's company
      // and the requested identity; unknown and foreign are the same 404.
      if (snapshot.issue.companyId !== companyId || (path.issue !== snapshot.issue.id && path.issue !== snapshot.issue.identifier)) return respond(404);
      // Defend against an upstream that ignores the conditional header.
      const currentEtag = snapshotEtag(snapshot);
      if (etag && etag !== currentEtag) return respond(412);
      return respond(200, project(snapshot), currentEtag);
    } catch {
      // A failed upstream read never yields a partial or mixed snapshot.
      return respond(502);
    }
  };
}
