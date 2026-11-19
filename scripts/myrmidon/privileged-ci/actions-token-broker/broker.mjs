import { randomUUID } from 'node:crypto';
import { verifyIdentity } from './identity.mjs';
import { createReplayStore } from './replay.mjs';
import { createCredentialStore } from './store.mjs';

export function createSingleHostBroker({ store, ...options }) {
  if (store) throw new Error('durable issuance store must be managed by broker');
  return createSingleHostBrokerWithStore(options);
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
  const store = createCredentialStore(credentialPath, credentialKey);
  try {
    const result = await store.revokeRetained(token => options.installation.revoke(token));
    const pending = (await store.pendingIssuances()).length > 0;
    // Attempt both notifications independently; durable rows remain on any failure.
    let alertFailed = false;
    for (const event of [pending && 'issuance_ambiguous', result.failed && 'credential_recovery_failed'].filter(Boolean)) {
      try { if (typeof options.alert === 'function') await options.alert(event); }
      catch { alertFailed = true; }
    }
    if (result.failed) throw new Error('credential recovery failed');
    if (pending) throw new Error('ambiguous issuance requires operator containment');
    if (alertFailed) throw new Error('recovery alert failed');
    const broker = createSingleHostBrokerWithStore({ ...options, store });
    return { ...broker, close: () => { broker.close(); store.close(); } };
  } catch (error) {
    store.close();
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
          credential = await installation.issue();
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
        if (durable) await store.resolveIssuance(handle);
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
