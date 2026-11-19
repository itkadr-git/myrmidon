import { randomUUID } from 'node:crypto';
import { verifyIdentity } from './identity.mjs';
import { createReplayStore } from './replay.mjs';
import { createCredentialStore } from './store.mjs';
import { acquireExclusiveStore } from './exclusive.mjs';
import { createRecoverySupervisor } from './recovery-supervisor.mjs';

// Retain exclusive ownership across all retries and for the broker lifetime.
export async function createSupervisedSingleHostBroker({ credentialPath, credentialKey, store: suppliedStore, delay, ...options }) {
  if (suppliedStore || typeof delay !== 'function' || typeof options.alert !== 'function') throw new Error('supervised recovery dependencies required');
  const release = acquireExclusiveStore(credentialPath);
  let store;
  try {
    store = createCredentialStore(credentialPath, credentialKey);
    const supervisor = createRecoverySupervisor({
      store, delay, alert: options.alert,
      recover: async () => ({ ...await store.revokeRetained(token => options.installation.revoke(token)), pending: (await store.pendingIssuances()).length > 0, alertFailed: false }),
      start: async () => createSingleHostBrokerWithStore({ ...options, store }),
    });
    const broker = await supervisor.run();
    return { ...broker, close: () => { broker.assertIdle(); try { broker.close(); store.close(); } finally { release(); } } };
  } catch (error) {
    try { store?.close(); } finally { release(); }
    throw error;
  }
}

export function createSingleHostBroker({ store, ...options }) {
  if (store) throw new Error('durable issuance store must be managed by broker');
  const release = acquireExclusiveStore(options.credentialPath);
  try {
    const broker = createSingleHostBrokerWithStore(options);
    return { ...broker, close: () => { broker.assertIdle(); try { broker.close(); } finally { release(); } } };
  } catch (error) { release(); throw error; }
}

function createSingleHostBrokerWithStore({ replayPath, credentialPath, credentialKey, store: suppliedStore, ...options }) {
  if (typeof replayPath !== 'string' || !replayPath || replayPath === ':memory:' || replayPath.startsWith('file:')) throw new Error('persistent replay path required');
  const replay = createReplayStore(replayPath);
  let store;
  try {
    store = suppliedStore ?? createCredentialStore(credentialPath, credentialKey);
    if (!['reserveIssuance', 'resolveIssuance', 'pendingIssuances'].every(name => typeof store[name] === 'function')) throw new Error('durable issuance store required');
  } catch (error) {
    replay.close();
    throw error;
  }
  // A restarted unsupervised broker must not issue until retained credentials
  // have gone through recovery; owner revocation remains available.
  const recoveryRequired = store.hasRetainedCredentials();
  const broker = createBroker({ ...options, store, recoveryRequired, claimOnce: replay.claimOnce });
  return { ...broker, close: () => { broker.shutdown(); replay.close(); if (!suppliedStore) store.close(); } };
}

// Call only while issuance is quiesced across all processes sharing the store.
export async function createRecoveredSingleHostBroker({ credentialPath, credentialKey, store: suppliedStore, ...options }) {
  if (suppliedStore) throw new Error('persistent recovery store required');
  const release = acquireExclusiveStore(credentialPath);
  let store;
  try {
    store = createCredentialStore(credentialPath, credentialKey);
    const result = await store.revokeRetained(token => options.installation.revoke(token));
    const pending = (await store.pendingIssuances()).length > 0;
    // Persist each notification before delivery and retry the outbox on restart.
    for (const event of [pending && 'issuance_ambiguous', result.failed && 'credential_recovery_failed'].filter(Boolean)) {
      await store.queueAlert(event);
    }
    let alertFailed = false;
    for (const event of await store.pendingAlerts()) {
      try {
        if (typeof options.alert !== 'function') throw new Error('alert sink unavailable');
        await options.alert(event);
        await store.acknowledgeAlert(event);
      } catch { alertFailed = true; }
    }
    if (result.failed) throw new Error('credential recovery failed');
    if (pending) throw new Error('ambiguous issuance requires operator containment');
    if (alertFailed) throw new Error('recovery alert failed');
    const broker = createSingleHostBrokerWithStore({ ...options, store });
    return { ...broker, close: () => { broker.assertIdle(); try { broker.close(); store.close(); } finally { release(); } } };
  } catch (error) {
    try { store?.close(); } finally { release(); }
    throw error;
  }
}

// The store must persist encrypted credentials and enforce owner-bound atomic access.
export function createBroker({ policy, loadKeys, claimOnce, installation, store, audit, alert, recoveryRequired = false, anchoredIssuance = false }) {
  const fixedPolicy = Object.freeze({ ...policy });
  let auditFailed = false, activeRequests = 0, closed = false;
  function assertIdle() { if (activeRequests) throw new Error('broker has in-flight requests'); }
  function shutdown() { assertIdle(); closed = true; }
  async function identity(jwt) {
    const claims = await verifyIdentity(jwt, { policy: fixedPolicy, loadKeys, claimOnce });
    if (typeof claims.run_id !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_id) || typeof claims.run_attempt !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_attempt)) throw new Error('identity rejected');
    return JSON.stringify([claims.repository_owner_id, claims.repository_id, claims.run_id, claims.run_attempt]);
  }
  async function record(event) {
    // Audit receives only a fixed event name, never claims, errors or credentials.
    try { await audit(event); } catch (error) {
      auditFailed = true;
      try { await store.queueAlert('audit_unavailable'); } catch { /* Storage failure requires external supervision. */ }
      try { await alert('audit_unavailable'); } catch { /* Recovery retries the durable outbox. */ }
      throw error;
    }
  }
  async function ambiguous() {
    // Fence this process even if the reservation or outbox is lost.
    auditFailed = true;
    // Keep the outbox entry even after immediate delivery: recovery acknowledges it.
    try { if (typeof store.queueAlert === 'function') await store.queueAlert('issuance_ambiguous'); } catch { /* Reservation remains pending. */ }
    try { await record('issuance_ambiguous'); } catch { /* Reservation remains pending. */ }
    try { if (typeof alert === 'function') await alert('issuance_ambiguous'); } catch { /* Recovery retries from the reservation. */ }
  }
  async function guarded(event, operation) {
    if (closed) throw new Error('broker closed');
    activeRequests++;
    try {
      return await operation();
    } catch {
      try { await record(event); } catch { /* Audit failure remains fail-closed. */ }
      throw new Error('broker request failed');
    } finally { activeRequests--; }
  }
  return {
    assertIdle, shutdown,
    async exchange(jwt) {
      return guarded('exchange_failed', async () => {
        const owner = await identity(jwt);
        if (auditFailed || recoveryRequired) throw new Error('recovery required');
        const handle = randomUUID();
        const durable = typeof store.reserveIssuance === 'function';
        if (durable) await store.reserveIssuance(handle);
        // A concurrent audit failure may have occurred while reserving.
        // Keep the reservation for recovery instead of contacting GitHub.
        if (auditFailed) throw new Error('audit unavailable');
        // Anchor the intent before contacting GitHub; a crash then blocks restart
        // even if the local reservation is later lost or rolled back.
        if (anchoredIssuance) await record('issuance_pending');
        // Another request can fail audit while the anchor write is in flight.
        if (auditFailed) throw new Error('audit unavailable');
        let credential, retained = false;
        try {
          credential = await installation.issue(async token => {
            try {
              await store.put(handle, { token }, owner);
            } catch {
              // Retry transient failures while the rejected token is still known.
              await store.put(handle, { token }, owner);
            }
            retained = true;
          });
        } catch {
          // The upstream may have created a token despite the failed response.
          await ambiguous();
          throw new Error('issuance outcome unknown');
        }
        try {
          if (!retained) await store.put(handle, credential, owner);
        } catch {
          try {
            await installation.revoke(credential.token);
            if (durable) {
              try { await store.resolveIssuance(handle); } catch (error) {
                auditFailed = true;
                try { await store.reserveIssuance(handle); } catch { /* Existing fence or storage failure. */ }
                throw error;
              }
            }
          } catch {
            // A transient storage failure must not discard a known, active token.
            try { await store.put(handle, { token: credential.token }, owner); } catch { /* Keep the reservation even if retention remains impossible. */ }
            await ambiguous();
          }
          throw new Error('credential storage failed');
        }
        try {
          if (auditFailed) throw new Error('audit unavailable');
          await record('issued');
          if (auditFailed) throw new Error('audit unavailable');
        } catch {
          // Keep the reservation even after successful revocation: audit failure
          // requires recovery and alert delivery before issuing again.
          try {
            await installation.revoke(credential.token);
            await store.delete(handle);
          } catch { await ambiguous(); }
          throw new Error('audit failed');
        }
        if (durable) {
          try { await store.resolveIssuance(handle); }
          catch {
            // Also fence the running process if durable storage cannot be restored.
            auditFailed = true;
            // A lost acknowledgement may mean the reservation was already removed.
            // Restore it before attempting revocation; an existing reservation is safe.
            try { await store.reserveIssuance(handle); } catch { /* Existing reservation or storage failure. */ }
            // Revoke immediately, but keep any retained token if revocation fails.
            try { await installation.revoke(credential.token); await store.delete(handle); } catch { /* Recovery retries the retained credential. */ }
            await ambiguous();
            throw new Error('issuance finalization failed');
          }
        }
        if (anchoredIssuance && !auditFailed) {
          try { await record('issuance_resolved'); } catch {
            try { await installation.revoke(credential.token); await store.delete(handle); } catch { /* Recovery retries retained credentials. */ }
            await ambiguous();
            throw new Error('issuance audit finalization failed');
          }
        }
        if (auditFailed) {
          // Finalization may have yielded while another request detected audit failure.
          // Retain a recovery fence where possible before revoking the known token.
          if (durable) { try { await store.reserveIssuance(handle); } catch { /* Alert and process latch remain in force. */ } }
          try { await installation.revoke(credential.token); await store.delete(handle); } catch { /* Retained token is retried during recovery. */ }
          await ambiguous();
          throw new Error('audit failed');
        }
        return { handle, ...credential };
      });
    },
    async revoke(jwt, handle) {
      return guarded('revoke_failed', async () => {
        const owner = await identity(jwt);
        if (typeof handle !== 'string' || !/^[0-9a-f-]{36}$/.test(handle)) throw new Error('invalid handle');
        if (auditFailed) throw new Error('audit unavailable');
        // Reserve before revocation: a crash or failure must keep issuance fenced.
        const durable = typeof store.reserveIssuance === 'function';
        const attempt = randomUUID();
        if (durable) await store.reserveIssuance(attempt);
        if (auditFailed) throw new Error('audit unavailable');
        // Protect the revocation fence against local store rollback as well.
        if (anchoredIssuance) await record('issuance_pending');
        if (auditFailed) throw new Error('audit unavailable');
        try {
          await store.withOwned(handle, owner, async credential => {
            await installation.revoke(credential.token);
          });
          await record('revoked');
          if (durable) {
            try { await store.resolveIssuance(attempt); } catch (error) {
              // The deletion may have committed despite a lost acknowledgement.
              auditFailed = true;
              try { await store.reserveIssuance(attempt); } catch { /* Existing fence or unavailable storage. */ }
              throw error;
            }
          }
          if (anchoredIssuance) await record('issuance_resolved');
        } catch (error) {
          try { if (typeof store.queueAlert === 'function') await store.queueAlert('credential_recovery_failed'); } catch { /* Reservation or process latch remains in force. */ }
          try { if (typeof alert === 'function') await alert('credential_recovery_failed'); } catch { /* Recovery retries the alert. */ }
          throw error;
        }
      });
    },
  };
}
