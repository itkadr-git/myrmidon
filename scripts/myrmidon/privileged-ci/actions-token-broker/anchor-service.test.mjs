import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';
import { provisionSqliteAnchor, createSqliteAnchor } from './sqlite-anchor.mjs';
import { createRemoteAnchor } from './remote-anchor.mjs';
import { createAnchorServer } from './anchor-service.mjs';
import { createCredentialStore } from './store.mjs';
import { createCredentialCheckpoint, checkpointCredentialStore } from './credential-checkpoint.mjs';
import { createAuditedSupervisedServer } from './tls.mjs';

test('independent anchor service persists CAS across restart and authorizes the client certificate', async () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), '.cache', 'myrmidon-broker-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(scratch, 'anchor-service-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=fixture CA', '-days', '1');
    for (const name of ['server', 'client', 'other']) {
      run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
      run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1');
    }
    const file = name => readFileSync(join(dir, name));
    const dbPath = join(dir, 'anchor.sqlite');
    provisionSqliteAnchor(dbPath);
    const fingerprint = new X509Certificate(file('client.crt')).fingerprint256;
    const tls = { key: file('server.key'), cert: file('server.crt'), ca: file('ca.crt') };
    const start = async () => {
      const store = createSqliteAnchor(dbPath);
      const server = createAnchorServer({ tls, store, allowedFingerprint256: fingerprint });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { server, store };
    };
    const client = (server, name) => createRemoteAnchor({ url: `https://server:${server.address().port}/head`, ca: file('ca.crt'), cert: file(`${name}.crt`), key: file(`${name}.key`), lookup: (_host, options, cb) => options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4) });
    let instance = await start();
    const zero = { seq: 0, mac: '' }, next = { seq: 1, mac: 'a'.repeat(64) };
    try {
      await assert.rejects(client(instance.server, 'other').read(), /anchor read failed/);
      assert.equal(await client(instance.server, 'client').compareAndSet(zero, next), true);
      assert.equal(await client(instance.server, 'client').compareAndSet(zero, next), false);
    } finally { await new Promise(resolve => instance.server.close(resolve)); instance.store.close(); }
    instance = await start();
    try {
      const anchor = client(instance.server, 'client');
      assert.deepEqual(await anchor.read(), next);
      await assert.rejects(createAsyncAuthenticatedAudit(join(dir, 'empty.sqlite'), randomBytes(32), anchor), /anchor mismatch/);
    } finally { await new Promise(resolve => instance.server.close(resolve)); instance.store.close(); }

    // A remote or otherwise asynchronous store must not turn a rejected CAS into 204.
    const asyncServer = createAnchorServer({ tls, allowedFingerprint256: fingerprint, store: {
      read: async () => zero,
      compareAndSet: async () => false,
    } });
    await new Promise(resolve => asyncServer.listen(0, '127.0.0.1', resolve));
    try {
      const anchor = client(asyncServer, 'client');
      assert.deepEqual(await anchor.read(), zero);
      assert.equal(await anchor.compareAndSet(zero, next), false);
    } finally { await new Promise(resolve => asyncServer.close(resolve)); }

    // A corrupt store must not be advertised as a healthy anchor.
    const corruptServer = createAnchorServer({ tls, allowedFingerprint256: fingerprint, store: {
      read: async () => ({ seq: 1, mac: 'corrupt' }),
      compareAndSet: async () => false,
    } });
    await new Promise(resolve => corruptServer.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(client(corruptServer, 'client').read(), /anchor read failed/);
    } finally { await new Promise(resolve => corruptServer.close(resolve)); }

    // Simulate a committed CAS whose response is lost at the service boundary.
    const lostPath = join(dir, 'lost-response.sqlite');
    provisionSqliteAnchor(lostPath);
    const lostStore = createSqliteAnchor(lostPath);
    const lostServer = createAnchorServer({ tls, allowedFingerprint256: fingerprint, store: {
      read: () => lostStore.read(),
      compareAndSet: (previous, next) => {
        assert.equal(lostStore.compareAndSet(previous, next), true);
        throw new Error('response lost after durable commit');
      },
    } });
    await new Promise(resolve => lostServer.listen(0, '127.0.0.1', resolve));
    try {
      const anchor = client(lostServer, 'client');
      const auditPath = join(dir, 'lost-audit.sqlite'), key = randomBytes(32);
      const audit = await createAsyncAuthenticatedAudit(auditPath, key, anchor);
      await assert.rejects(audit.record('issued'), /anchor update failed/);
      audit.close();
      assert.equal((await anchor.read()).seq, 1);
      await assert.rejects(createAsyncAuthenticatedAudit(auditPath, key, anchor), /anchor mismatch/);
    } finally { await new Promise(resolve => lostServer.close(resolve)); lostStore.close(); }

    // A separate anchor starts at genesis; exercise the real audit over mTLS.
    const isolatedPath = join(dir, 'independent.sqlite');
    provisionSqliteAnchor(isolatedPath);
    let store = createSqliteAnchor(isolatedPath);
    let server = createAnchorServer({ tls, store, allowedFingerprint256: fingerprint });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      let anchor = client(server, 'client');
      const auditPath = join(dir, 'audit.sqlite'), auditKey = randomBytes(32);
      const audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
      await audit.record('issued');
      audit.close();
      const snapshot = join(dir, 'audit-snapshot.sqlite');
      copyFileSync(auditPath, snapshot);
      const reopened = await createAsyncAuthenticatedAudit(auditPath, auditKey, anchor);
      await reopened.record('revoked');
      reopened.close();
      const db = new DatabaseSync(auditPath);
      db.exec('DELETE FROM audit_events WHERE seq = 2');
      db.close();
      await assert.rejects(createAsyncAuthenticatedAudit(auditPath, auditKey, anchor), /anchor mismatch/);
      const credentialPath = join(dir, 'recovery.sqlite'), credentialKey = randomBytes(32);
      let credentialHead = { seq: 0, mac: '' };
      const credentialAnchor = { read: async () => ({ ...credentialHead }), compareAndSet: async (previous, next) => {
        if (JSON.stringify(previous) !== JSON.stringify(credentialHead)) return false;
        credentialHead = { ...next }; return true;
      } };
      const rawCredentials = createCredentialStore(credentialPath, credentialKey);
      const credentials = checkpointCredentialStore(rawCredentials, await createCredentialCheckpoint(rawCredentials, credentialAnchor, { provision: true }));
      await credentials.put('known', { token: 'fixture-known' }, 'owner');
      await credentials.reserveIssuance('unknown');
      credentials.close();
      const revoked = [], alerts = [];
      let attempts = 0, delays = 0;
      await assert.rejects(createAuditedSupervisedServer({}, {
        auditPath, auditKey, auditAnchor: anchor, credentialPath, credentialKey, credentialAnchor,
        installation: { revoke: async token => { attempts++; if (attempts === 1) throw new Error('offline'); revoked.push(token); } },
        alert: async event => alerts.push(event), delay: async () => { delays++; },
      }), /anchor mismatch/);
      assert.equal(attempts, 2);
      assert.equal(delays, 1);
      assert.deepEqual(revoked, ['fixture-known']);
      assert.ok(alerts.includes('audit_unavailable'));
      assert.ok(alerts.includes('issuance_ambiguous'));
      const recovered = createCredentialStore(credentialPath, credentialKey);
      try {
        assert.equal(recovered.hasRetainedCredentials(), false);
        assert.equal((await recovered.pendingIssuances()).length, 1);
      } finally { recovered.close(); }
      // Restart the anchor service and restore a valid historical audit snapshot.
      await new Promise(resolve => server.close(resolve));
      store.close();
      store = createSqliteAnchor(isolatedPath);
      server = createAnchorServer({ tls, store, allowedFingerprint256: fingerprint });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      anchor = client(server, 'client');
      copyFileSync(snapshot, auditPath);
      await assert.rejects(createAsyncAuthenticatedAudit(auditPath, auditKey, anchor), /anchor mismatch/);
    } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
