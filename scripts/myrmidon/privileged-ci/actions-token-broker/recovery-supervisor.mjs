// Run with exclusive ownership of the store; no issuer may run concurrently.
export function createRecoverySupervisor({ recover, start, alert, delay }) {
  if (![recover, start, alert, delay].every(value => typeof value === 'function')) throw new Error('recovery dependencies required');
  let stopped = false, running = false;
  const undelivered = new Set();
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
          const clean = result && result.failed === 0 && result.pending === false && result.alertFailed === false;
          if (!clean) undelivered.add(result?.pending ? 'issuance_ambiguous' : 'credential_recovery_failed');
          for (const event of undelivered) {
            try { await alert(event); undelivered.delete(event); } catch { /* Retry before starting. */ }
          }
          if (clean && undelivered.size === 0) return await start();
          if (!stopped) await delay();
        }
        throw new Error('recovery supervisor stopped');
      } finally { running = false; }
    },
  };
}
