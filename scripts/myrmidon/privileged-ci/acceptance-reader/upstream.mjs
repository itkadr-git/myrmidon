import { request } from 'node:https';
import { parsePath } from './reader.mjs';

// Upstream is an operator-controlled mTLS endpoint, never a request-supplied URL.
export function createUpstream({ origin, ca, cert, key }) {
  let url;
  try { url = new URL(origin); } catch { throw new TypeError('invalid upstream origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !ca || !cert || !key) throw new TypeError('invalid upstream configuration');
  const fetchJson = (path, match) => new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port || 443, path, method: 'GET', ca, cert, key, rejectUnauthorized: true, timeout: 5000, headers: { accept: 'application/json', ...(match ? { 'if-match': match } : {}) } }, (res) => {
      if (res.statusCode === 404) { res.resume(); resolve(null); return; }
      if (res.statusCode === 409 || res.statusCode === 412) { res.resume(); reject(Object.assign(new Error('revision changed'), { code: 'PRECONDITION_FAILED' })); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('upstream rejected request')); return; }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { res.destroy(new Error('upstream response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const revision = value?.document?.latestRevisionId;
          if (value?.document !== null && (typeof revision !== 'string' || !/^[A-Za-z0-9_-]+$/.test(revision) || res.headers.etag !== `"${revision}"`)) throw new Error('invalid upstream revision');
          if (match && match !== res.headers.etag) { reject(Object.assign(new Error('revision changed'), { code: 'PRECONDITION_FAILED' })); return; }
          resolve(value);
        } catch { reject(new Error('invalid upstream response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
  return Object.freeze({
    readSnapshot: async (id, match) => {
      if (typeof id !== 'string' || !parsePath(`/api/issues/${id}`)) throw new TypeError('invalid issue identity');
      return fetchJson(`/api/service/issues/${id}/acceptance-scenarios`, match);
    },
  });
}
