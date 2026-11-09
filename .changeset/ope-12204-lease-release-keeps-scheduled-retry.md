---
"@myrmidon/server": patch
---

Preserve a queued run's scheduled retry when the environment lease releases during teardown. `terminalizeRunOnLeaseRelease` no longer forces a queued run that still carries `scheduled_retry_at` to `interrupted` / `lease_released_before_terminal`, so a retry scheduled before the lease cleanup survives it and is dispatched instead of burning the wake-up.
