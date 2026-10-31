# DEVFLOW health alerts

The existing attention-feed collection runtime reads DEVFLOW signals from persisted database events. It does not call a model, poll GitHub, create agent runs, or create a second timer. A recovered condition disappears on the next attention refresh; dismissals use the normal attention-feed mechanism. Cards are deduplicated by company, metric, and subject.

Sources:
- Engineer idle (`engineerIdleMs`): agents with role `engineer` and status `idle`, aged from lastHeartbeatAt (creation for never-run engineers). Running, paused and retired agents are excluded.
- Review queue (`reviewQueueAgeMs`): visible in_review issues, aged from the latest persisted issue.updated transition into in_review, not subsequent comment/update time. Issues without transition history use creation time.
- Red CI (`redCiMs`): normalized workflow_run/check_suite completion receipts for a registered GitHub pull_request work product on an active issue. The repository and PR number must match within the company. A first failed completion starts the interval; success clears it; cancellation/skips/pending events do not start or clear it. Repeated failed completions preserve the first failure time. Without connector receipts, no red-CI alert is invented.
- Approval-to-PR-marker step (`staleMarkerMs`): active issues with a registered GitHub pull_request work product where an APPROVE review verdict has been recorded (via issue execution decisions or review comments), but the `review-approved` marker on the PR is missing or stale (older than the latest APPROVE verdict, or head SHA moved after review). Aged from the approval verdict timestamp. Automatically clears when the PR marker is applied, head matches, verdict is revoked/changed, or the PR is merged/closed.
- Auto-merge step (`stalledMergeMs`): approved PRs on active issues that remain open and unmerged beyond the threshold. Aged from the approval / marker timestamp. Automatically clears when the PR is merged, closed, or approval is revoked.
- Review router queue / scheduler (`stalledRouterMs`): issues in `in_review` requiring reviewer assignment where the issue has remained unrouted beyond the threshold. Aged from the transition into `in_review`. Automatically clears when a reviewer is assigned or the issue transitions out of `in_review`.
- Approved not merged (`approvedNotMergedMs`): active issues with a registered GitHub `pull_request` work product that is approved (via reviewState, metadata reviewApproved flags/labels, or an APPROVE reviewer verdict comment `^APPROVE PR #N <sha>`) but not merged or closed, aged from approval time. Re-requesting changes (`^REQUEST CHANGES PR #N` or rework verdicts) clears approval until re-approved. Approval timestamp is stable against work product metadata updates (backed by activity log and comment timestamps, not mutable updatedAt).
- No merges in 6h (`noMergesMs`): triggers when active PR queue is non-empty and 0 merges have occurred across the company in the configured duration (default 6 hours), aged from the latest merged PR's completion time (or oldest active PR creation time if no PR has been merged yet).

Configuration (milliseconds): `instance_settings.general.devflowHealth` accepts:
- `engineerIdleMs` (default 3600000 = 60 min, override `MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS`)
- `reviewQueueAgeMs` (default 86400000 = 24 h, override `MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS`)
- `redCiMs` (default 3600000 = 60 min, override `MYRMIDON_DEVFLOW_RED_CI_MS`)
- `staleMarkerMs` / alias `approvalMarkerMs` (default 3600000 = 60 min, override `MYRMIDON_DEVFLOW_STALE_MARKER_MS` / `MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS`)
- `stalledMergeMs` / alias `autoMergeMs` (default 3600000 = 60 min, override `MYRMIDON_DEVFLOW_STALLED_MERGE_MS` / `MYRMIDON_DEVFLOW_AUTO_MERGE_MS`)
- `stalledRouterMs` / alias `reviewRouterMs` (default 3600000 = 60 min, override `MYRMIDON_DEVFLOW_STALLED_ROUTER_MS` / `MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS`)
- `approvedNotMergedMs` (default 7200000 = 2 h, override `MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS`)
- `noMergesMs` (default 21600000 = 6 h, override `MYRMIDON_DEVFLOW_NO_MERGES_MS`)

Invalid, negative and nonfinite values fall back to defaults. Zero alerts immediately. The generic settings UI is not extended; operators can configure the environment at release time.

Verification: thresholds.myrmidon.test.ts covers configured boundaries, aliases, defaults, and missing values; signals.myrmidon.test.ts covers runtime signal dedup identity, below-threshold behavior, stale marker detection, stalled auto-merge, stalled router queue, canonical and Cyrillic verdict parsing, author/reviewer constraints, PR approval/rework reset chronology, and automatic recovery chronology; collector.myrmidon.test.ts covers SQL prefiltering, status filtering, repo/number handling, and collector behavior. Full typecheck/build and affected tests run in PR CI. Production verification belongs to ADM after deploying the CI image.

Operational limit: CI reflects the normalized completion stream, not an aggregate GitHub branch-protection verdict. Multiple independent workflows can produce interleaved completions; these cards are advisory, not merge authorization. Connector event retention limits how far back a red interval can be reconstructed.
