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
const VERIFY_PATH = new RegExp(`^/api/issues/(${ISSUE})/acceptance-snapshot/verify$`);
const VERIFY_BODY_LIMIT = 64 * 1024;

export function parsePath(path) {
  let match = PIN_PATH.exec(path);
  if (match) return { issue: match[1], verify: false };
  match = VERIFY_PATH.exec(path);
  if (match) return { issue: match[1], verify: true };
  return null;
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

// The pin tuple is the entire single-snapshot response: the issue identity
// (including the trigger-bumped mutation version), and, when present, the
// document identity, monotonic generation and body. Two responses with equal
// canonical pins were read from moments between which no relevant mutation
// committed — that equality is what POST /verify asserts server-side.
function canonicalPin(snapshot) {
  // BigInt-normalize the version: leading zeros cannot create distinct
  // pins for the same generation.
  return JSON.stringify({
    i: [snapshot.issue.id, snapshot.issue.identifier, snapshot.issue.companyId, BigInt(snapshot.issue.version).toString()],
    d: snapshot.document == null ? null : [
      snapshot.document.id,
      snapshot.document.latestRevisionId,
      snapshot.document.latestRevisionNumber,
      snapshot.document.body,
    ],
  });
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

function readBody(req, limit = VERIFY_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// The gateway answers from ONE upstream read per request: the atomic
// acceptance snapshot (a single SQL statement upstream). GET returns the
// full pin projection; POST /verify is the server-side conditional
// assertion — the gateway reads a fresh snapshot and compares the caller's
// pinned snapshot on its own side. The stored credential's company is
// checked before anything is returned, and credential revocation is
// re-checked immediately before the response, so revocation or expiry
// during the upstream read fails closed.
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
    if ((req.method !== 'GET' && req.method !== 'POST') || !path || Object.keys(req.headers).some((name) => name.includes('method-override') || name === 'x-http-method')) return respond(404);
    if (path.verify !== (req.method === 'POST')) return respond(404);
    try {
      // For verify, take and validate the bounded request body BEFORE the
      // fresh upstream read, so a slow client cannot pin the comparison to
      // a moment older than its own evidence.
      let pinned;
      if (path.verify) {
        try {
          pinned = JSON.parse(await readBody(req));
        } catch {
          return respond(400);
        }
        if (!validSnapshot(pinned)) return respond(400);
      }
      const snapshot = await readSnapshot(path.issue);
      // Upstream not-found: the identical 404 for foreign and unknown issues.
      if (snapshot === null || snapshot === undefined) return respond(404);
      // A 200 payload that does not match the snapshot contract is an
      // upstream malfunction, not "not found": fail closed with 502 before
      // anything is projected.
      if (!validSnapshot(snapshot)) return respond(502);
      // Fail closed on anything that does not match the credential's company
      // and the requested identity; unknown and foreign are the same 404.
      if (snapshot.issue.companyId !== companyId || (path.issue !== snapshot.issue.id && path.issue !== snapshot.issue.identifier)) return respond(404);
      if (!path.verify) return respond(200, project(snapshot));

      // Server-side conditional assertion: the caller's pinned snapshot was
      // validated before the fresh read; compare now. Match means "no
      // relevant mutation committed between the pin and this verify" — the
      // freshest statement this read-only gateway can make. The caller must
      // use the result immediately and re-verify before any later use.
      if (pinned.issue.companyId !== companyId || (path.issue !== pinned.issue.id && path.issue !== pinned.issue.identifier)) return respond(404);
      if (canonicalPin(pinned) !== canonicalPin(snapshot)) return respond(409);
      return respond(200, { ok: true });
    } catch {
      // A failed upstream read never yields a partial or mixed snapshot.
      return respond(502);
    }
  };
}
