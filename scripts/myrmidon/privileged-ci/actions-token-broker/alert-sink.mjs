import https from 'node:https';

const events = new Set(['issuance_ambiguous', 'credential_recovery_failed', 'audit_unavailable']);

// Delivery is at-least-once: a lost response must leave the durable alert queued.
export function createAlertSink({ url, ca, cert, key, timeoutMs = 5000, lookup }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || !ca || !cert || !key || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid alert sink configuration');
  return async event => {
    if (!events.has(event)) throw new Error('invalid recovery alert');
    const body = JSON.stringify({ event });
    await new Promise((resolve, reject) => {
      const req = https.request(target, { method: 'POST', ca, cert, key, rejectUnauthorized: true, lookup, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('alert delivery failed')));
      });
      const timer = setTimeout(() => req.destroy(new Error('alert delivery timeout')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(body);
    });
  };
}
