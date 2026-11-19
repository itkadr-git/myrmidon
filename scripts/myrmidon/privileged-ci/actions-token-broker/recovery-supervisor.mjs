// Run with exclusive ownership of the store; no issuer may run concurrently.
export function createRecoverySupervisor({ recover, start, alert, delay }) {
  if (![recover, start, alert, delay].every(value => typeof value === 'function')) throw new Error('recovery dependencies required');
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
          if (stopped) break;
          if (result && result.failed === 0 && result.pending === false && result.alertFailed === false) return await start();
          const event = result?.pending ? 'issuance_ambiguous' : 'credential_recovery_failed';
          try { await alert(event); } catch { /* Retry the durable condition on the next pass. */ }
          if (!stopped) await delay();
        }
        throw new Error('recovery supervisor stopped');
      } finally { running = false; }
    },
  };
}
