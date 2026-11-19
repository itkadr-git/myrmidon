import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { createAlertSink } from './alert-sink.mjs';

test('authenticated HTTPS alert delivers only an allowlisted event and rejects non-success', async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-broker-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(scratch, 'alert-sink-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=fixture CA', '-days', '1');
    for (const name of ['server', 'client']) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1');
    }
    const file = name => readFileSync(join(dir, name));
    let status = 503, received = [];
    const server = https.createServer({ key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(status); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const sink = createAlertSink({ url: `https://server:${server.address().port}/alerts`, ca: file('ca.crt'), cert: file('client.crt'), key: file('client.key'), lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4) });
      await assert.rejects(sink('issuance_ambiguous'));
      status = 204;
      await sink('issuance_ambiguous');
      await assert.rejects(sink('secret token'));
      assert.deepEqual(received, [{ event: 'issuance_ambiguous' }, { event: 'issuance_ambiguous' }]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
