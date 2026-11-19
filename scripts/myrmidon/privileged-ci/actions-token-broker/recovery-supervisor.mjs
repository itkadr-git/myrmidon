// Run with exclusive ownership of the store; no issuer may run concurrently.
export function createRecoverySupervisor({ recover, start, alert, delay, store }) {
  if (![recover, start, alert, delay, store?.queueAlert, store?.pendingAlerts, store?.pendingAlertEntries, store?.acknowledgeAlert].every(value => typeof value === 'function')) throw new Error('recovery dependencies required');
  let stopped = false, running = false, started = false;
  const unqueued = new Set();
  return {
    stop() { stopped = true; },
    async run() {
      if (running || started) throw new Error('recovery supervisor already running or started');
      running = true;
      const stoppedError = new Error('recovery supervisor stopped');
      try {
        while (!stopped) {
          let result;
          try { result = await recover(); } catch { result = { failed: 1, pending: false, alertFailed: false }; }
          const clean = result && result.failed === 0 && result.pending === false && result.alertFailed === false;
          for (const event of [result?.pending && 'issuance_ambiguous', !clean && (!result?.pending || result?.failed !== 0 || result?.alertFailed !== false) && 'credential_recovery_failed'].filter(Boolean)) unqueued.add(event);
          let outboxFailed = false;
          for (const event of unqueued) {
            try { await store.queueAlert(event); unqueued.delete(event); } catch {
              outboxFailed = true;
              try { await alert(event); } catch { /* Independent process monitoring remains required. */ }
            }
          }
          if (stopped) break;
          // Keep revoking on later passes even if the outbox is unavailable.
          if (outboxFailed) { await delay(); continue; }
          for (const { event, generation } of await store.pendingAlertEntries()) {
            try { await alert(event); await store.acknowledgeAlert(event, generation); } catch { /* Retry before starting. */ }
          }
          const pendingAlerts = await store.pendingAlerts();
          if (stopped) break;
          if (clean && pendingAlerts.length === 0) {
            // A failed start may have partially activated an issuer; never retry it.
            started = true;
            return await start();
          }
          if (!stopped) await delay();
        }
        throw stoppedError;
      } catch (error) {
        // An outbox failure still requires notification during shutdown.
        if (error !== stoppedError) {
          try { await alert('credential_recovery_failed'); } catch { /* External process monitoring is still required. */ }
        }
        throw error;
      } finally { running = false; }
    },
  };
}
