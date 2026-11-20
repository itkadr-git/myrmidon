import https from 'node:https';

function validHead(head) {
  return head && Number.isSafeInteger(head.seq) && head.seq >= 0 && (head.seq === 0 ? head.mac === '' : typeof head.mac === 'string' && /^[0-9a-f]{64}$/.test(head.mac));
}

// Run on a separately administered host and storage domain; never auto-provision.
export function createAnchorServer({ tls, store, allowedFingerprint256 }) {
  if (!tls?.key || !tls?.cert || !tls?.ca || typeof store?.read !== 'function' || typeof store?.compareAndSet !== 'function' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(allowedFingerprint256)) throw new Error('invalid anchor service configuration');
  return https.createServer({ ...tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, async (req, res) => {
    if (!req.client.authorized || req.socket.getPeerCertificate().fingerprint256 !== allowedFingerprint256) { res.writeHead(403).end(); return; }
    if (req.url !== '/head') { res.writeHead(404).end(); return; }
    if (req.method === 'GET') {
      try { const head = await store.read(); if (!validHead(head)) throw new Error('invalid anchor head'); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ seq: head.seq, mac: head.mac })); }
      catch { res.writeHead(500).end(); }
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = '', tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 4096) { tooLarge = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooLarge) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (!validHead(parsed?.previous) || !validHead(parsed?.next) || parsed.next.seq !== parsed.previous.seq + 1) { res.writeHead(400).end(); return; }
      try {
        const result = await store.compareAndSet(parsed.previous, parsed.next);
        if (result !== true && result !== false) throw new Error('invalid CAS result');
        res.writeHead(result ? 204 : 409).end();
      } catch { res.writeHead(500).end(); }
    });
  });
}
