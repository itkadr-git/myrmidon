const MAX_BODY = 20000;

// Deploy only behind a TLS server configured with requestCert and rejectUnauthorized.
export function createHandler(broker) {
  return async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!req.socket.encrypted || !req.socket.authorized) return reply(403, { error: 'forbidden' });
    if (req.method !== 'POST' || !['/exchange', '/revoke'].includes(req.url)) return reply(404, { error: 'not found' });
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return reply(413, { error: 'request too large' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const expected = req.url === '/exchange' ? ['jwt'] : ['handle', 'jwt'];
      if (!body || Array.isArray(body) || typeof body !== 'object' || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected) || expected.some(key => typeof body[key] !== 'string' || !body[key])) return reply(400, { error: 'invalid request' });
      if (req.url === '/exchange') return reply(200, await broker.exchange(body.jwt));
      await broker.revoke(body.jwt, body.handle);
      return reply(200, { revoked: true });
    } catch {
      return reply(403, { error: 'forbidden' });
    }
  };
}
