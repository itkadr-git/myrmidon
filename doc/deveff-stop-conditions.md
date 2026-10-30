# 1.6.6 DEVEFF: Stop Conditions, Empty-Run Metrics, and Required Artifact Gate

## 1. Executive Summary

This document defines the runtime guardrails, event contracts, dashboard metrics query,
and stop rules for development efficiency (DEVEFF) across Myrmidon/Paperclip agent runs.

### Objectives
1. **Detect Unproductive Cycles**: Detect no-op runs and repeated tool error loops early.
2. **Stop Condition & Escalation**: Abort consecutive tool error loops (threshold: 3) and escalate
   recurring empty runs (threshold: 5 consecutive) to `blocked` to stop token-burning loops.
3. **Completion Gate**: Prevent agent runs from exiting in `in_progress` without concrete evidence
   (commit, pull request, deliverable artifact/work product, status transition, or explicit blocker).
4. **Metrics Dashboard**: Provide 14-day agent performance metrics, empty-run ratios, and progress toward
   the −30% empty-run reduction target via both SQL queries and the REST API.
5. **No Expensive Benchmarks**: Guard logic and event emission are verified via deterministic unit tests.

---

## 2. Run-Log Event Schema Contract

The following run-log events are recorded in `heartbeat_run_events` and documented in `doc/run-log-events.md`:

### 2.1 `run.deveff.no_op`
Written when a heartbeat run concludes without producing any code commits, pull requests,
created or updated work products, document revisions, or issue status transitions.

**Payload Schema:**
```json
{
  "rule": "no_op",
  "reason": "no_changes_and_no_status_transition" | "empty_response" | "no_progress",
  "description": "Human-readable diagnosis of the empty run",
  "issueId": "UUID | null",
  "gateMet": "none" | "commit_or_pr" | "status_change" | "explicit_blocker",
  "gatePassed": false,
  "gateReason": "Completion gate failed: run ended without commit/PR, status change, or explicit blocker with reason"
}
```

### 2.2 `run.deveff.repeated_tool_error`
Written when an agent enters a failure loop by repeating failing tool operations consecutively
(threshold: 3 consecutive failures of the same tool, e.g. repeated failing `patch` or shell command).

**Payload Schema:**
```json
{
  "rule": "repeated_tool_error",
  "reason": "repeated_tool_errors",
  "description": "Repeated tool failure loop detected (patch failed 3 times consecutively)",
  "issueId": "UUID | null",
  "gateMet": "none",
  "gatePassed": false,
  "gateReason": "Run failed due to repeated tool errors"
}
```

---

## 3. Completion Gate & Stop Rule Guard

### 3.1 Completion Gate (`evaluateCompletionGate`)
When an agent run completes:
- **Pass Conditions**:
  1. Status transitioned away from `in_progress` (to `done`, `in_review`, `blocked`, `cancelled`).
  2. Concrete artifact produced: `commitsCreated > 0`, `pullRequestsCreated > 0`, `workProductsCreated > 0`, `documentRevisionsCreated > 0`, or `workspaceOperationsCreated > 0`.
  3. Explicit blocker recorded: `statusAfter === "blocked"` or valid `unblockDescriptor` / `blockedByIssueIds`.
- **Fail Condition**:
  - Run leaves issue in `in_progress` with zero artifacts, zero commits/PRs, and no explicit blocker.

### 3.2 Escalation Policy (`checkAndHandleEmptyRunEscalation`)
- Consecutive empty runs are tracked in `agent_wakeup_requests` / `issue` context metadata.
- If consecutive empty runs reach **5**:
  - Issue is automatically transitioned to `blocked` (`status: "blocked"`).
  - Diagnostic comment is added explaining the empty-run stall.
  - Auto-rewake is cancelled (`shouldRewake: false`), preventing unbounded token consumption.

---

## 4. Dashboard Metrics SQL Query

The canonical PostgreSQL query for Grafana, Superset, or internal analytics dashboards:

```sql
WITH runs_14d AS (
  SELECT
    r.id AS run_id,
    r.company_id,
    r.agent_id,
    a.name AS agent_name,
    r.created_at,
    r.status,
    r.liveness_state,
    r.liveness_reason,
    COALESCE(r.native_issue_id::text, r.context_issue_id, r.context_snapshot->>'issueId') AS issue_id
  FROM heartbeat_runs r
  JOIN agents a ON a.id = r.agent_id
  WHERE r.company_id = :companyId
    AND r.created_at >= NOW() - INTERVAL '14 days'
    AND r.status IN ('succeeded', 'failed')
),
run_events_agg AS (
  SELECT
    run_id,
    BOOL_OR(event_type = 'run.deveff.no_op') AS has_no_op,
    BOOL_OR(event_type = 'run.deveff.repeated_tool_error') AS has_repeated_error
  FROM heartbeat_run_events
  WHERE company_id = :companyId
    AND created_at >= NOW() - INTERVAL '14 days'
    AND event_type IN ('run.deveff.no_op', 'run.deveff.repeated_tool_error')
  GROUP BY run_id
)
SELECT
  r.agent_id,
  r.agent_name,
  COUNT(r.run_id) AS total_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') AS empty_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR r.liveness_reason ILIKE '%no file changes%') AS no_op_runs,
  COUNT(r.run_id) FILTER (WHERE ev.has_repeated_error OR r.liveness_reason ILIKE '%Repeated tool failure%') AS repeated_error_runs,
  ROUND(
    COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') * 100.0 / NULLIF(COUNT(r.run_id), 0),
    1
  ) AS empty_run_ratio_pct,
  -- 30% reduction target from baseline
  ROUND(
    (COUNT(r.run_id) FILTER (WHERE ev.has_no_op OR ev.has_repeated_error OR r.liveness_state = 'empty_response' OR r.liveness_reason ILIKE '%no file changes%' OR r.liveness_reason ILIKE '%Repeated tool failure%') * 100.0 / NULLIF(COUNT(r.run_id), 0)) * 0.7,
    1
  ) AS target_ratio_pct
FROM runs_14d r
LEFT JOIN run_events_agg ev ON ev.run_id = r.run_id
GROUP BY r.agent_id, r.agent_name
ORDER BY empty_runs DESC, total_runs DESC;
```

---

## 5. REST API Report Endpoint

**Endpoint:** `GET /api/companies/:companyId/reports/empty-runs?days=14`

**Response Structure:**
```json
{
  "companyId": "uuid",
  "periodDays": 14,
  "startDate": "2026-10-16T...",
  "endDate": "2026-10-30T...",
  "dashboardSqlQuery": "WITH runs_14d AS ...",
  "summary": {
    "totalRuns": 120,
    "emptyRuns": 18,
    "emptyRunRatio": 15.0,
    "targetReductionPercent": 30
  },
  "agents": [
    {
      "agentId": "uuid",
      "agentName": "adm-dev-eng-24",
      "agentRole": "engineer",
      "totalRuns": 24,
      "emptyRuns": 2,
      "emptyRunRatio": 8.3,
      "breakdown": {
        "noChanges": 1,
        "repeatedToolErrors": 1,
        "emptyResponse": 0
      }
    }
  ]
}
```
