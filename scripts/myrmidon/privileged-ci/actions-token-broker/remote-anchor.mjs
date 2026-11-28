import https from 'node:https';

function validHead(head) {
  return head && Number.isSafeInteger(head.seq) && head.seq >= 0 &&
    (head.seq === 0 ? head.mac === '' : typeof head.mac === 'string' && /^[0-9a-f]{64}$/.test(head.mac));
}

// The endpoint must itself provide durable linearizable CAS in a separate failure domain.
export function createRemoteAnchor({ url, ca, cert, key, timeoutMs = 5000, lookup }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || !ca || !cert || !key || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid remote anchor configuration');
  function request(method, payload) {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? '' : JSON.stringify(payload);
      const req = https.request(target, { method, ca, cert, key, rejectUnauthorized: true, minVersion: 'TLSv1.2', lookup, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(new Error('anchor response too large')); });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      const timer = setTimeout(() => req.destroy(new Error('anchor request timeout')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(body);
    });
  }
  return {
    async read() {
      const response = await request('GET');
      if (response.status !== 200) throw new Error('anchor read failed');
      let head;
      try { head = JSON.parse(response.data); } catch { throw new Error('invalid anchor response'); }
      if (!validHead(head)) throw new Error('invalid anchor head');
      return { seq: head.seq, mac: head.mac };
    },
    async compareAndSet(previous, next) {
      if (!validHead(previous) || !validHead(next) || next.seq !== previous.seq + 1) throw new Error('invalid anchor transition');
      const response = await request('POST', { previous, next });
      if (response.status === 409) return false;
      if (response.status !== 204) throw new Error('anchor update failed');
      return true;
    },
  };
}
