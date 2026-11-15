OPE-13202 checkpoint (2026-11-15)
- `server/src/myrmidon/idle-pickup.ts:390-495`: existing idle-pickup candidate query handles assigned todo/in_progress and review participant issues, but includes no last activity/age field.
- `server/src/myrmidon/idle-pickup.ts:625-688`: per-agent pickup loads candidates and heartbeatRuns; `:812-839` explicitly defers review CI; `:969-981` avoids duplicate in-flight wake.
- `server/src/myrmidon/idle-pickup.ts:992-1042`: automation wake currently reason `idle_pickup`; shared admission and activity log are wired.
- `server/src/myrmidon/idle-pickup.ts:1260-1399`: scheduler sweep cadence currently 30s default, loops eligible/invokable/non-maintenance agents; triggers ordinary pickup only.
- `server/src/services/heartbeat.ts:21715-21744`: sweeper wiring, invokability/maintenance shared. `server/src/index.ts:3073` invokes sweep.
- `server/src/myrmidon/run-cap-no-commit.ts:15`: reason constant; no direct run-cap block helper found in idle pickup. Need inspect heartbeat cap enforcement at `server/src/services/heartbeat.ts:32846-32890` for reusable eligibility.
- Current branch `bot/OPE-13202-rebased` clean and pushed to origin, at origin/main SHA 996f446a94. No feature edits or tests yet; local tests prohibited by runtime repository rules.
