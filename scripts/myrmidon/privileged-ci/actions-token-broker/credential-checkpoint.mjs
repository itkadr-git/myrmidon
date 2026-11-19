import { randomBytes } from 'node:crypto';

// A checkpoint anchor must be separately provisioned and protected from rollback.
// This primitive alone does not make store updates atomic with the anchor.
export async function createCredentialCheckpoint(store, anchor, { provision = false } = {}) {
  if (typeof store?.stateDigest !== 'function' || typeof anchor?.read !== 'function' || typeof anchor?.compareAndSet !== 'function') throw new Error('invalid credential checkpoint configuration');
  let head = await anchor.read();
  const digest = store.stateDigest();
  if (provision) {
    if (head.seq !== 0 || head.mac !== '' || store.hasRetainedCredentials() || (await store.pendingIssuances()).length || (await store.pendingAlerts()).length) throw new Error('invalid credential checkpoint provisioning');
    const initial = { seq: 1, mac: digest };
    if (await anchor.compareAndSet(head, initial) !== true) throw new Error('credential checkpoint provisioning failed');
    head = initial;
  } else if (head.seq < 1 || head.mac !== digest) {
    throw new Error('credential checkpoint mismatch');
  }
  let busy = false, failed = false;
  return {
    async mutate(operation) {
      if (busy || failed || typeof operation !== 'function') throw new Error('credential checkpoint unavailable');
      busy = true;
      try {
        // A durable random fence precedes the local mutation; any interruption
        // leaves a mismatch that prevents restart, including a lost CAS reply.
        const fence = { seq: head.seq + 1, mac: randomBytes(32).toString('hex') };
        if (await anchor.compareAndSet(head, fence) !== true) throw new Error('credential checkpoint fence failed');
        const result = await operation();
        const next = { seq: fence.seq + 1, mac: store.stateDigest() };
        if (await anchor.compareAndSet(fence, next) !== true) throw new Error('credential checkpoint update failed');
        head = next;
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally { busy = false; }
    },
    async advance(currentStore) {
      if (busy || failed || currentStore !== store) throw new Error('invalid credential checkpoint update');
      busy = true;
      try {
        const next = { seq: head.seq + 1, mac: currentStore.stateDigest() };
        if (await anchor.compareAndSet(head, next) !== true) throw new Error('credential checkpoint update failed');
        head = next;
      } finally { busy = false; }
    },
  };
}

// Wrap every mutation, including recovery's internally performed deletions.
export function checkpointCredentialStore(store, checkpoint) {
  const wrapped = { ...store };
  for (const name of ['queueAlert', 'acknowledgeAlert', 'reserveIssuance', 'resolveIssuance', 'put', 'delete', 'withOwned', 'revokeRetained']) {
    if (typeof store[name] !== 'function') throw new Error('invalid credential store');
    wrapped[name] = (...args) => checkpoint.mutate(() => store[name](...args));
  }
  return wrapped;
}
