import { randomUUID } from 'node:crypto';
import { verifyIdentity } from './identity.mjs';

// The store must persist encrypted credentials and enforce owner-bound atomic access.
export function createBroker({ policy, loadKeys, claimOnce, installation, store, audit }) {
  async function identity(jwt) {
    const claims = await verifyIdentity(jwt, { policy, loadKeys, claimOnce });
    if (typeof claims.run_id !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_id) || typeof claims.run_attempt !== 'string' || !/^[1-9][0-9]*$/.test(claims.run_attempt)) throw new Error('identity rejected');
    return JSON.stringify([claims.repository_owner_id, claims.repository_id, claims.run_id, claims.run_attempt]);
  }
  async function record(event) {
    // Audit receives only a fixed event name, never claims, errors or credentials.
    await audit(event);
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
        const credential = await installation.issue();
        const handle = randomUUID();
        try {
          await store.put(handle, credential, owner);
        } catch {
          try { await installation.revoke(credential.token); } catch { await record('revoke_failed'); }
          throw new Error('credential storage failed');
        }
        try {
          await record('issued');
        } catch {
          // Keep the stored credential for recovery if revocation fails.
          try {
            await installation.revoke(credential.token);
            await store.delete(handle);
          } catch { /* The original audit failure remains the public error. */ }
          throw new Error('audit failed');
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
