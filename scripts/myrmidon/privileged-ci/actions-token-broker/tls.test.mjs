import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { createSecureServer } from './tls.mjs';

test('mTLS server accepts an authorized certificate and rejects an anonymous client', async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-broker-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(scratch, 'broker-tls-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=fixture CA', '-days', '1');
    for (const name of ['server', 'client']) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1');
    }
    const file = name => readFileSync(join(dir, name));
    const server = createSecureServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') }, {
      exchange: async () => ({ token: 'fixture-only' }),
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const request = credentials => new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port: server.address().port, path: '/exchange', method: 'POST', ca: file('ca.crt'), servername: 'server', ...credentials }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject); req.end(JSON.stringify({ jwt: 'fixture' }));
      });
      const ok = await request({ key: file('client.key'), cert: file('client.crt') });
      assert.equal(ok.status, 200);
      assert.equal(JSON.parse(ok.body).token, 'fixture-only');
      await assert.rejects(request({}));
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
