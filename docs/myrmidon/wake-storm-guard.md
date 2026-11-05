# Wake storm guard

`enqueueWakeup` applies a per-agent, per-source sliding-window circuit breaker before creating a run. The default is 20 admissions per 10 seconds. The 21st wake pauses that source until the window expires and writes `heartbeat.wake_storm_guard_tripped` to the activity log. Source identity is taken from `wakeSource`, `sourceKey`, `triggerId`, `watchdogId`, then the wake reason/source.

Configuration:

- `MYRMIDON_WAKE_STORM_LIMIT` — positive integer, default `20`.
- `MYRMIDON_WAKE_STORM_WINDOW_MS` — positive milliseconds, default `10000`.

Manual user wakes bypass the guard. Event-priority digest and taskless-wake suppression run independently after this admission guard.
