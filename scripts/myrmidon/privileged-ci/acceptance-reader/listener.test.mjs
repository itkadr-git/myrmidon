import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createListener } from './listener.mjs';

 test('TLS listener serves only authenticated projected reads and rejects untrusted peers', async (t) => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || tmpdir(), 'reader-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const token = 'candidate-test-token';
  const events = [];
  const server = createListener({ tls: { key: readFileSync(key), cert: readFileSync(cert) }, records: [{ tokenHash: createHash('sha256').update(token).digest('hex'), companyId: 'company-a', expiresAt: Date.now() + 60000, revoked: false }], readSnapshot: async () => ({ issue: { id: 'issue-id', identifier: 'OPE-123', companyId: 'company-a', version: '1', secret: 'never-return' }, document: null }), audit: async (event) => events.push(event) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const call = (options = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', servername: 'localhost', port: server.address().port, path: '/api/issues/OPE-123', ca: readFileSync(cert), headers: { authorization: `Bearer ${token}` }, ...options }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { identifier: 'OPE-123', companyId: 'company-a' });
  assert.equal((await call({ method: 'POST' })).status, 404);
  await assert.rejects(call({ ca: undefined }));
  assert.ok(!JSON.stringify(events).includes(token));
  assert.ok(!JSON.stringify(events).includes('never-return'));
});

test('listener refuses missing TLS credentials', () => {
  assert.throws(() => createListener({ tls: {}, readIssue: async () => {} }), TypeError);
});
