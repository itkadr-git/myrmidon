# WAKE-10 / OPE-9502 / OPE-9657: Event Priorities (P0–P4) & Low-Priority Digest

Based on plan-166 §10 (OPE-9479 / OPE-9502), agent events are classified by priority P0–P4:
- **P0**: Emergency / Outage / Security — immediately wakes agent.
- **P1**: Operational completions (CI / Review / Unblock / Approval) — immediately wakes agent.
- **P2**: Actionable assignments & comments — wakes agent when actionable work exists.
- **P3**: Routine progress, timing, and activity metrics — accumulated in digest without waking.
- **P4**: Heartbeats, no-ops, duplicates, logs — accumulated in digest without waking.

## Event Priority Mapping Table

| Priority | Category | Example Event Types | Wake Behavior |
|---|---|---|---|
| **P0** | Emergency / Security / Outage | `security_incident`, `service_outage`, `system_failure`, `budget.incident.opened`, `run_stalled`, `emergency` | Immediate Wake |
| **P1** | CI / Review / Approvals / Unblocks | `ci_completed`, `review_completed`, `execution_review_requested`, `issue_unblock_requested`, `issue_blockers_resolved`, `unanswered_question` | Immediate Wake |
| **P2** | Assignments & Actionable Items | `issue_assigned`, `issue_commented`, `issue_children_completed`, `task_assigned` | Wake on Actionable |
| **P3** | Progress / Info / Activity | `busy`, `progress`, `info`, `activity.logged`, `cost_event.created`, `run.phase.timing` | Accumulate in Digest (No Wake) |
| **P4** | Heartbeats / No-ops / Logs | `heartbeat`, `heartbeat_timer`, `timer`, `noop`, `no-op`, `duplicate`, `log` (and unknown fallback) | Accumulate in Digest (No Wake) |

## Low-Priority Event Digest (WAKE-10.2)

Low-priority events (P3 and P4) do not trigger runs or wakeups for the agent, preventing unnecessary token burn and hollow runs (26.10 metrics: 387 timer wakeups with 0% result). Instead:
1. Low-priority events are accumulated in the agent's pending event digest buffer (`EventDigestService`).
2. When an immediate wake event (P0 or P1) or actionable trigger (P2) occurs, the accumulated digest is delivered alongside the triggering event in the wake payload (`eventDigest`).
3. Once delivered, the pending buffer is drained, preventing duplicate deliveries.
