// A checkpoint anchor must be separately provisioned and protected from rollback.
// This primitive alone does not make store updates atomic with the anchor.
export async function createCredentialCheckpoint(store, anchor, { provision = false } = {}) {
  if (typeof store?.stateDigest !== 'function' || typeof anchor?.read !== 'function' || typeof anchor?.compareAndSet !== 'function') throw new Error('invalid credential checkpoint configuration');
  let head = await anchor.read();
  const digest = store.stateDigest();
  if (provision) {
    if (head.seq !== 0 || head.mac !== '' || store.hasRetainedCredentials()) throw new Error('invalid credential checkpoint provisioning');
    const initial = { seq: 1, mac: digest };
    if (await anchor.compareAndSet(head, initial) !== true) throw new Error('credential checkpoint provisioning failed');
    head = initial;
  } else if (head.seq < 1 || head.mac !== digest) {
    throw new Error('credential checkpoint mismatch');
  }
  let busy = false;
  return {
    async advance(currentStore) {
      if (busy || currentStore !== store) throw new Error('invalid credential checkpoint update');
      busy = true;
      try {
        const next = { seq: head.seq + 1, mac: currentStore.stateDigest() };
        if (await anchor.compareAndSet(head, next) !== true) throw new Error('credential checkpoint update failed');
        head = next;
      } finally { busy = false; }
    },
  };
}
