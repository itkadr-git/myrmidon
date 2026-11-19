import { request } from 'node:https';
import { isIssueIdentity } from './reader.mjs';

// Upstream is an operator-controlled mTLS endpoint, never a request-supplied URL.
export function createUpstream({ origin, ca, cert, key }) {
  let url;
  try { url = new URL(origin); } catch { throw new TypeError('invalid upstream origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !ca || !cert || !key) throw new TypeError('invalid upstream configuration');
  const fetchJson = (path) => new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port || 443, path, method: 'GET', ca, cert, key, rejectUnauthorized: true, timeout: 5000, headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        // The status rides on the error so readSnapshot can tell the board's
        // not-found (404) apart from real failures — without that split the
        // gateway would answer unknown issues 502 where foreign issues get
        // 404, an existence oracle (OPE-15145).
        res.resume();
        const error = new Error('upstream rejected request');
        error.status = res.statusCode ?? 0;
        reject(error);
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { res.destroy(new Error('upstream response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid upstream response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
  const snapshotPath = (id) => {
    if (!isIssueIdentity(id)) throw new TypeError('invalid issue identity');
    return `/api/issues/${id}/acceptance-scenarios-snapshot`;
  };
  return Object.freeze({
    // One request, one atomic snapshot: the issue identity and the document
    // revision upstream always come from the same MVCC snapshot. Upstream
    // not-found resolves null (the gateway answers the identical 404 for
    // foreign and unknown issues); every other failure — 5xx, network,
    // timeout, oversized or invalid payload — rejects so the gateway fails
    // closed with 502 and never a partial body.
    readSnapshot: async (id) => {
      try {
        return await fetchJson(snapshotPath(id));
      } catch (error) {
        if (error && error.status === 404) return null;
        throw error;
      }
    },
  });
}
