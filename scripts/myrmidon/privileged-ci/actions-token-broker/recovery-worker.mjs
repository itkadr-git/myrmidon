// Run only while all issuers sharing this store are stopped.
export function createRecoveryWorker({ store, revoke, alert }) {
  if (!store || typeof revoke !== 'function' || typeof alert !== 'function') throw new Error('recovery dependencies required');
  let active = false;
  return {
    async runOnce() {
      if (active) throw new Error('recovery already running');
      active = true;
      try {
        const result = await store.revokeRetained(revoke);
        const pending = (await store.pendingIssuances()).length > 0;
        let alertFailed = false;
        for (const event of [pending && 'issuance_ambiguous', result.failed && 'credential_recovery_failed'].filter(Boolean)) {
          await store.queueAlert(event);
        }
        for (const event of await store.pendingAlerts()) {
          try { await alert(event); await store.acknowledgeAlert(event); } catch { alertFailed = true; }
        }
        return { ...result, pending, alertFailed };
      } finally { active = false; }
    },
  };
}
