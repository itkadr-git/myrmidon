<!-- Relocated verbatim from SKILL.md (OPE-11947). Paths are relative to the skill root; "Step N" and "below" keep their original meaning: Steps 1-7 and 9 are in heartbeat-procedure.md, Step 8 in disposition-and-monitors.md, Comment Style in comments-and-planning.md. -->

### Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition and create an artifact work product. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

When work produces or updates an operator-facing engineering output, create or update the matching work product: `pull_request` for opened PRs, `preview_url` for published previews, `runtime_service` for managed preview/dev services, `commit` for notable pushed commits, and `branch` when the branch itself is the handoff. Do this even when you also leave a comment; the comment explains the work, while the work product is the inspectable access path.

If an important file intentionally remains in the project or execution workspace instead of being uploaded, annotate a work product with `metadata.resourceRef.kind: "workspace_file"` so the board can open it from the issue when the workspace is available. Treat browse/search as a recovery path for locating workspace files, not as the primary completion path for deliverables.

For technical upload instructions, read `references/artifacts.md`, except for
the routine server-verified external-chat handoff described above.

**Step 8 — Update status and communicate.** Always include the run ID header.

**Bounded write retry.** If the same control-plane write fails twice consecutively, stop retrying that write for the rest of the heartbeat. Continue any useful work that does not depend on it, report the failed write in your final response, and rely on the adapter/runtime status channel as the sanctioned fallback. Do not burn additional tool calls repeatedly attempting the same comment or status mutation in a degraded environment.

**Verify writes — never infer them.** A successful `PATCH /api/issues/{id}` always returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail` and never rely on `curl -f` inside a pipeline — the pipe swallows curl's exit status, and a lost connection then looks identical to success. Use `scripts/paperclip-issue-update.sh` (it checks the HTTP status, retries connection-level failures, and confirms the echoed `status`); if you must hand-roll curl, capture `-w '%{http_code}'` and check the response echoes your update. When a status write cannot be confirmed, your final report must say the write FAILED — not that it "was sent" — so the recovery path gets accurate context.

Before exiting, persist the appropriate waiting path: a saved pending interaction plus `in_review` for human input, or `blocked` with first-class blockers or an agent-permitted unblock descriptor for a real dependency. A comment naming someone does not create that path.

Before ending any heartbeat, apply this final-disposition checklist:

- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue.
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an actually-scheduled issue monitor (non-null `monitorNextCheckAt`, not merely described in a comment) that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or a real scheduled monitor/recovery path (not a narrated one) that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $MYRMIDON_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$MYRMIDON_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `pheromoneStrength`, `casteKey`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`, `labelIds`.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

### Monitors and Watchers (say only what you actually scheduled)

A "watcher" or "monitor" is not something that lives inside a run. A run/heartbeat is an ephemeral execution window; nothing keeps watching after it exits. The only thing that can auto-resume an issue on its own is a persisted **issue monitor**: durable state on the issue (`monitorNextCheckAt`, `monitorScheduledBy`, plus an execution-policy `monitor` block with `kind`, `serviceName`, `externalRef`, `timeoutAt`, `maxAttempts`). A server scheduler (`tickDueIssueMonitors`) polls for **eligible** issues whose `monitorNextCheckAt` has passed and re-wakes the assignee agent with `MYRMIDON_WAKE_REASON=issue_monitor_due`. Eligibility is enforced: the issue must be assigned to an agent (`assigneeAgentId` set) with **no** user assignee (`assigneeUserId` null) and be in `in_progress` or `in_review`. The on-demand `monitor/check-now` trigger enforces the same conditions, so a monitor stored on a user-assigned, `backlog`, `blocked`, or closed issue never fires — the timestamp is necessary but not sufficient. It is timer-based polling, not an event subscription — Myrmidon is not notified the instant CI/Greptile/an external check finishes; the monitor just wakes you on a schedule so you can look again.

Because of that, follow these rules:

- **Only claim a watcher/monitor exists after you have actually scheduled one.** Describing a watcher in a comment does not create it. Schedule it by setting `executionPolicy.monitor.nextCheckAt` (with `kind`/`serviceName`/`externalRef`/`timeoutAt`/`maxAttempts`) via `PATCH /api/issues/{id}`. Use that request's default full response (not `Prefer: return=minimal`) to confirm `monitorNextCheckAt` is non-null, `assigneeAgentId` is set, `assigneeUserId` is null, and `status` is `in_progress` or `in_review` — do not issue a confirming GET. The stored timestamp only fires under those conditions. Run a check on demand with `POST /api/issues/{id}/monitor/check-now`.
- **Describe it in checkable terms.** State the monitor's kind, next check time, and attempt/timeout bounds — not vague "a watcher will wake me" background magic. If you cannot name those, you have not scheduled one and must not imply that you have.
- **Never imply a live watcher on a task you are marking `done`.** `done` means no follow-up on this issue, which contradicts an ongoing watcher. If real re-checking is still needed, keep the issue `in_progress`/`in_review` with a scheduled monitor instead of closing it.
- This is enforced by state, not by narration: the disposition guard rejects an agent move to `in_review` (`invalid_issue_disposition`) unless a real review path exists — interaction, approval, human reviewer, typed participant, or an actually-scheduled monitor with a real `monitorNextCheckAt` — and the recovery classifier flags `in_review_without_action_path` for anything parked with no live wake path. Keep your comments consistent with that real state.
