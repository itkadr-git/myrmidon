// Run only while all issuers sharing this store are stopped.
export function createRecoveryWorker({ store, revoke, alert, anchoredPending = false }) {
  if (!store || typeof revoke !== 'function' || typeof alert !== 'function') throw new Error('recovery dependencies required');
  let active = false;
  return {
    async runOnce() {
      if (active) throw new Error('recovery already running');
      active = true;
      try {
        let result, recoveryReadFailed = false;
        try { result = await store.revokeRetained(revoke); } catch {
          result = { revoked: 0, failed: 1 };
          recoveryReadFailed = true;
          try { await alert('credential_recovery_failed'); } catch { /* Independent monitoring is required. */ }
        }
        let pending = true, alertFailed = recoveryReadFailed;
        try { pending = anchoredPending || (await store.pendingIssuances()).length > 0; } catch {
          // Unknown reservation state remains fenced while known-token retries continue.
          alertFailed = true;
          try { await alert('credential_recovery_failed'); } catch { /* Independent monitoring is required. */ }
        }
        for (const event of [pending && 'issuance_ambiguous', result.failed && 'credential_recovery_failed'].filter(Boolean)) {
          try { await store.queueAlert(event); } catch {
            // Outbox failure must not prevent a later known-token revoke retry.
            alertFailed = true;
            try { await alert(event); } catch { /* Independent monitoring is required. */ }
            if (event !== 'credential_recovery_failed') {
              try { await alert('credential_recovery_failed'); } catch { /* Independent monitoring is required. */ }
            }
          }
        }
        try {
          for (const { event, generation } of await store.pendingAlertEntries()) {
            try { await alert(event); await store.acknowledgeAlert(event, generation); } catch { alertFailed = true; }
          }
          if ((await store.pendingAlerts()).length) alertFailed = true;
        } catch {
          alertFailed = true;
          try { await alert('credential_recovery_failed'); } catch { /* Independent monitoring is required. */ }
        }
        return { ...result, pending, alertFailed };
      } finally { active = false; }
    },
  };
}
