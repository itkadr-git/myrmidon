import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { createRemoteAnchor } from './remote-anchor.mjs';

test('remote anchor uses authenticated TLS, validates heads, and rejects stale CAS', async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-broker-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(scratch, 'remote-anchor-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=fixture CA', '-days', '1');
    for (const name of ['server', 'client']) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1');
    }
    const file = name => readFileSync(join(dir, name));
    let head = { seq: 0, mac: '' }, malformed = false;
    const server = https.createServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      if (req.method === 'GET') { res.end(JSON.stringify(malformed ? { seq: -1, mac: '' } : head)); return; }
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        const { previous, next } = JSON.parse(body);
        if (JSON.stringify(previous) !== JSON.stringify(head)) { res.writeHead(409).end(); return; }
        head = next; res.writeHead(204).end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const anchor = createRemoteAnchor({ url: `https://server:${server.address().port}/head`, ca: file('ca.crt'), cert: file('client.crt'), key: file('client.key'), lookup: (_host, options, cb) => options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4) });
      const zero = { seq: 0, mac: '' }, next = { seq: 1, mac: 'a'.repeat(64) };
      assert.deepEqual(await anchor.read(), zero);
      assert.equal(await anchor.compareAndSet(zero, next), true);
      assert.equal(await anchor.compareAndSet(zero, next), false);
      assert.deepEqual(await anchor.read(), next);
      malformed = true;
      await assert.rejects(anchor.read(), /anchor/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
