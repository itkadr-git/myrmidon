// Run with exclusive ownership of the store; no issuer may run concurrently.
export function createRecoverySupervisor({ recover, start, alert, delay, store }) {
  if (![recover, start, alert, delay, store?.queueAlert, store?.pendingAlerts, store?.acknowledgeAlert].every(value => typeof value === 'function')) throw new Error('recovery dependencies required');
  let stopped = false, running = false;
  return {
    stop() { stopped = true; },
    async run() {
      if (running) throw new Error('recovery supervisor already running');
      running = true;
      try {
        while (!stopped) {
          let result;
          try { result = await recover(); } catch { result = { failed: 1, pending: false, alertFailed: false }; }
          const clean = result && result.failed === 0 && result.pending === false && result.alertFailed === false;
          if (result?.pending) await store.queueAlert('issuance_ambiguous');
          if (!clean && (!result?.pending || result?.failed !== 0 || result?.alertFailed !== false)) await store.queueAlert('credential_recovery_failed');
          if (stopped) break;
          for (const event of await store.pendingAlerts()) {
            try { await alert(event); await store.acknowledgeAlert(event); } catch { /* Retry before starting. */ }
          }
          const pendingAlerts = await store.pendingAlerts();
          if (stopped) break;
          if (clean && pendingAlerts.length === 0) return await start();
          if (!stopped) await delay();
        }
        throw new Error('recovery supervisor stopped');
      } catch (error) {
        // The outbox may itself be unavailable; notify independently before exiting.
        if (!stopped) {
          try { await alert('credential_recovery_failed'); } catch { /* External process monitoring is still required. */ }
        }
        throw error;
      } finally { running = false; }
    },
  };
}
