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
    return { ...broker, close: () => { try { broker.close(); store.close(); } finally { release(); } } };
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
    return { ...broker, close: () => { try { broker.close(); } finally { release(); } } };
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
  const broker = createBroker({ ...options, store, claimOnce: replay.claimOnce });
  return { ...broker, close: () => { replay.close(); if (!suppliedStore) store.close(); } };
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
    return { ...broker, close: () => { try { broker.close(); store.close(); } finally { release(); } } };
  } catch (error) {
    try { store?.close(); } finally { release(); }
    throw error;
  }
}

// The store must persist encrypted credentials and enforce owner-bound atomic access.
export function createBroker({ policy, loadKeys, claimOnce, installation, store, audit, alert }) {
  const fixedPolicy = Object.freeze({ ...policy });
  async function identity(jwt) {
    const claims = await verifyIdentity(jwt, { policy: fixedPolicy, loadKeys, claimOnce });
    if (typeof claims.run_id !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_id) || typeof claims.run_attempt !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_attempt)) throw new Error('identity rejected');
    return JSON.stringify([claims.repository_owner_id, claims.repository_id, claims.run_id, claims.run_attempt]);
  }
  async function record(event) {
    // Audit receives only a fixed event name, never claims, errors or credentials.
    await audit(event);
  }
  async function ambiguous() {
    // Keep the outbox entry even after immediate delivery: recovery acknowledges it.
    try { if (typeof store.queueAlert === 'function') await store.queueAlert('issuance_ambiguous'); } catch { /* Reservation remains pending. */ }
    try { await record('issuance_ambiguous'); } catch { /* Reservation remains pending. */ }
    try { if (typeof alert === 'function') await alert('issuance_ambiguous'); } catch { /* Recovery retries from the reservation. */ }
  }
  async function guarded(event, operation) {
    try {
      return await operation();
    } catch {
      try { await record(event); } catch { /* Audit failure remains fail-closed. */ }
      throw new Error('broker request failed');
    }
  }
  return {
    async exchange(jwt) {
      return guarded('exchange_failed', async () => {
        const owner = await identity(jwt);
        const handle = randomUUID();
        const durable = typeof store.reserveIssuance === 'function';
        if (durable) await store.reserveIssuance(handle);
        let credential;
        try {
          credential = await installation.issue(async token => {
            await store.put(handle, { token }, owner);
          });
        } catch {
          // The upstream may have created a token despite the failed response.
          await ambiguous();
          throw new Error('issuance outcome unknown');
        }
        try {
          await store.put(handle, credential, owner);
        } catch {
          try {
            await installation.revoke(credential.token);
            if (durable) await store.resolveIssuance(handle);
          } catch {
            await ambiguous();
          }
          throw new Error('credential storage failed');
        }
        try {
          await record('issued');
        } catch {
          // Retain the reservation and credential until revocation succeeds.
          try {
            await installation.revoke(credential.token);
            await store.delete(handle);
            if (durable) await store.resolveIssuance(handle);
          } catch { await ambiguous(); }
          throw new Error('audit failed');
        }
        if (durable) {
          try { await store.resolveIssuance(handle); }
          catch { await ambiguous(); throw new Error('issuance finalization failed'); }
        }
        return { handle, ...credential };
      });
    },
    async revoke(jwt, handle) {
      return guarded('revoke_failed', async () => {
        const owner = await identity(jwt);
        if (typeof handle !== 'string' || !/^[0-9a-f-]{36}$/.test(handle)) throw new Error('invalid handle');
        // The store must lock and check ownership atomically, retaining the entry if revocation fails.
        await store.withOwned(handle, owner, async credential => {
          await installation.revoke(credential.token);
      });
      await record('revoked');
      });
    },
  };
}
