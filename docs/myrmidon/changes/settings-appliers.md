## settings-appliers

The instance general settings document is the source of truth for every process. A successful PATCH commits the whole document under a row lock, then publishes `settings_changed` with the changed keys. The event is an invalidation hint, not a state carrier: listeners re-read the committed row before applying local effects. Periodic sweeps remain the fallback for processes that were offline or temporarily disconnected.

The applier registry currently handles `runLimits`, `teamLiveness`, `myrmidonMaintenance`, and `processes`. Unknown keys are ignored so newer senders can coexist with older processes during a rolling deploy.
