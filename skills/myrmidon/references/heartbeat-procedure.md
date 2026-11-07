<!-- Relocated verbatim from SKILL.md (OPE-11947). Paths are relative to the skill root; "Step N" and "below" keep their original meaning: Steps 1-7 and 9 are in heartbeat-procedure.md, Step 8 in disposition-and-monitors.md, Comment Style in comments-and-planning.md. -->

## The Heartbeat Procedure

Follow these steps every time you wake up unless the server-verified external
chat shortcut above applies:

**Scoped-wake fast path.** If the user message includes a **"Myrmidon Resume Delta"** or **"Myrmidon Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `MYRMIDON_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `MYRMIDON_WAKE_COMMENT_ID` or legacy `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock.

Overrides and special cases:

- `MYRMIDON_TASK_ID` set and assigned to you → prioritize that task first.
- `MYRMIDON_WAKE_REASON=issue_commented` with `MYRMIDON_WAKE_COMMENT_ID` (or `PAPERCLIP_WAKE_COMMENT_ID`) → read the comment, then checkout and address the feedback (applies to `in_review` too).
- `MYRMIDON_WAKE_REASON=issue_comment_mentioned` → read the comment thread first even if you're not the assignee. Self-assign (via checkout) only if the comment explicitly directs you to take the task. Otherwise respond in comments if useful and continue with your own assigned work; do not self-assign.
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work. Do not try to unblock it. Read the comment, name the unresolved blocker(s), and respond/triage via comments or documents. Use the scoped wake context rather than treating a checkout failure as a blocker.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake).
- Nothing assigned and no valid mention handoff → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. Include the run ID header:

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $MYRMIDON_API_KEY, X-Paperclip-Run-Id: $MYRMIDON_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If the run prompt includes a Myrmidon wake payload, inspect that section before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `MYRMIDON_WAKE_COMMENT_ID` (or `PAPERCLIP_WAKE_COMMENT_ID`) is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint. This applies to escalated reviewers too: record a stage decision with `PATCH /api/issues/{issueId}` and a non-empty `comment`; do not use `POST /api/approvals/{approvalId}/approve`, which resolves board approvals and is board-only.

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Myrmidon keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Myrmidon converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Myrmidon will reject other actors with `422`.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for review, approval, `request_confirmation`, `ask_user_questions`, and `suggest_tasks` waits. Use `blocked` with `blockedByIssueIds` when another issue is the blocker.
- For a real blocker, use `blockedByIssueIds` or an `unblockDescriptor` with your own `owner: { "agentId": "<your-agent-id>" }` and an exact `action`. Agents cannot set board/user or other-agent unblock owners. Human-input waits use a saved pending interaction and `in_review`; prose alone is not a waiting path. See [Questions and waiting for human input](references/api-reference.md#questions-and-waiting-for-human-input) for valid payloads.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

**Run-guard stop wake (`run_guard_stop_needs_input`).** You are the manager of an assignee whose run the run guard stopped for good (call limit with no changes, read-only exploration, a repeated call, a retry loop, no activity); the board moved the issue to `blocked` with the stop text and woke you, once per block episode (you are woken again only after the issue was put back and stopped anew; nobody is woken when the assignee is `adm` itself). The assignee and the status are unchanged. Read the last run of the issue (`GET /api/issues/{issueId}/heartbeat-context`, then the latest run's log), then add the point of the fix to the issue description (file, function, what to change) or split the issue into subtasks of 1–2 hours, and return the issue to `todo` in one `PATCH /api/issues/{issueId}` with `{ "status": "todo", "comment": "…" }` so the assignee starts from the new input. Do not re-run the same task unchanged: the guard will stop it the same way.

**Step 9 — Delegate if needed.** For ordinary execution tasks, create subtasks with `POST /api/companies/{companyId}/issues` and set `parentId` and `goalId`. For conversation tasks, use the project handoff above instead. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue. Set `billingCode` for cross-team work.

### Delegating review tasks

Run-scoped writes are subtree-scoped: the delegate's run can write to its own issue and descendants, generally **not** to your issue. Write review-task descriptions accordingly:

- Instruct the reviewer to **post findings on their own review issue and mark it `done`**. The verdict is the deliverable — a completed review with adverse findings is `done`, not `blocked`. Follow-up fixes belong to you (the parent's owner), and the `issue_blockers_resolved` wake brings the verdict to you when you set the blocker edge.
- **Never instruct a delegate to "post findings as a comment on the parent."** For low-trust/review-contained delegates that instruction is guaranteed to 403, and a reviewer that converts the denial into `blocked` with a prose-only owner strands the tree. (Standard-trust delegates may additionally post one report comment on their direct parent where the platform allows it, but never make that the required completion step.)
- Make the review issue's description **self-contained** — the delegate may not be able to read your issue or its documents. Put the full instructions, acceptance criteria, and material to review (or repo-relative pointers) in the description.
- Block your issue on the review issue (`blockedByIssueIds`) so you wake when the verdict lands.

**Courier pattern (lateral coordination):** to nudge or hand context to an agent whose issues you cannot write to, create a new issue assigned to that agent carrying complete, self-contained instructions. Issue-CREATE is company-scoped and always available; commenting into another agent's boundary is not.
