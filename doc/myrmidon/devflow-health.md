# DEVFLOW health alerts

The existing attention-feed collection runtime reads DEVFLOW signals from persisted database events. It does not call a model, poll GitHub, create agent runs, or create a second timer. A recovered condition disappears on the next attention refresh; dismissals use the normal attention-feed mechanism. Cards are deduplicated by company, metric, and subject.

Sources:
- Engineer idle: agents with role `engineer` and status `idle`, aged from lastHeartbeatAt (creation for never-run engineers). Running, paused and retired agents are excluded.
- Review queue: visible in_review issues, aged from the latest persisted issue.updated transition into in_review, not subsequent comment/update time. Issues without transition history use creation time.
- Red CI: normalized workflow_run/check_suite completion receipts for a registered GitHub pull_request work product on an active issue. The repository and PR number must match within the company. A first failed completion starts the interval; success clears it; cancellation/skips/pending events do not start or clear it. Repeated failed completions preserve the first failure time. Without connector receipts, no red-CI alert is invented.

Configuration (milliseconds): `instance_settings.general.devflowHealth` accepts engineerIdleMs (default 3600000), reviewQueueAgeMs (86400000), redCiMs (3600000). Deployment environment overrides are MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS, MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS and MYRMIDON_DEVFLOW_RED_CI_MS. Invalid, negative and nonfinite values fall back to defaults. Zero alerts immediately. The generic settings UI is not extended; operators can configure the environment at release time.

Verification: thresholds.myrmidon.test.ts covers configured boundaries and missing values; signals.myrmidon.test.ts covers runtime signal dedup identity, below-threshold behavior and CI failure/recovery chronology. Full typecheck/build and affected tests run in PR CI. Production verification belongs to ADM after deploying the CI image.

Operational limit: CI reflects the normalized completion stream, not an aggregate GitHub branch-protection verdict. Multiple independent workflows can produce interleaved completions; these cards are advisory, not merge authorization. Connector event retention limits how far back a red interval can be reconstructed.
