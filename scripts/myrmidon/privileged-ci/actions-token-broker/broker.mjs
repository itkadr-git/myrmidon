import { randomUUID } from 'node:crypto';
import { verifyIdentity } from './identity.mjs';

// The store must persist encrypted credentials and enforce owner-bound atomic access.
export function createBroker({ policy, loadKeys, claimOnce, installation, store, audit }) {
  async function identity(jwt) {
    return verifyIdentity(jwt, { policy, loadKeys, claimOnce });
  }
  async function record(event) {
    // Audit receives only a fixed event name, never claims, errors or credentials.
    await audit(event);
  }
  return {
    async exchange(jwt) {
      await identity(jwt);
      const credential = await installation.issue();
      const handle = randomUUID();
      try {
        await store.put(handle, credential);
      } catch {
        try { await installation.revoke(credential.token); } catch { await record('revoke_failed'); }
        throw new Error('credential storage failed');
      }
      await record('issued');
      return { handle, ...credential };
    },
    async revoke(jwt, handle) {
      await identity(jwt);
      if (typeof handle !== 'string' || !/^[0-9a-f-]{36}$/.test(handle)) throw new Error('invalid handle');
      const credential = await store.get(handle);
      if (!credential) throw new Error('credential not found');
      await installation.revoke(credential.token);
      await store.delete(handle);
      await record('revoked');
    },
  };
}
