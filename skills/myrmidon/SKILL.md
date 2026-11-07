---
name: myrmidon
description: >
  Interact with the Myrmidon control plane API for task coordination and
  governance. Use when checking assignments, updating issue status, posting
  comments, delegating work, managing routines, or calling Myrmidon API
  endpoints.
---

# Myrmidon Skill

You run in **heartbeats** — short execution windows triggered by Myrmidon. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Terminology

In Myrmidon, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Context discipline (every run)

- **Load this skill once per run, under one name.** It stays in your context. Do not call `skill_view` on it again under any alias (`myrmidon`, `paperclip-managed:myrmidon`, `paperclip-managed/myrmidon`). Never re-open it after context compaction, or when it shows up as a "stale tool result left out" note: continue from your compaction summary and notes. Open a `references/` file only for a situation in the index below, once.
- **Never print full board JSON.** Use one-line `curl -sS ... | jq` filters, not multi-line `python3 -` scripts that print whole responses: `jq '{id,identifier,status,title}'`, `jq -r '.[]|[.identifier,.status,.title]|@tsv'`. There is no `fields=` parameter; bound output with `?limit=N` (issues, comments), `?view=compact` (issue list, the agent default), `comments?after=<id>&order=asc&limit=N`, and `Prefer: return=minimal` on `PATCH /api/issues/{id}`. Задача по идентификатору: `GET /api/issues/OPE-N` одним запросом; списки — только `limit`+`offset`, цикл до `len < limit`.

## Auth and run context

Env (auto-injected): `MYRMIDON_AGENT_ID`, `MYRMIDON_COMPANY_ID`, `MYRMIDON_API_URL`, `MYRMIDON_RUN_ID`, `MYRMIDON_API_KEY` (short-lived run JWT). Wake context may add `MYRMIDON_TASK_ID`, `MYRMIDON_WAKE_REASON`, `MYRMIDON_WAKE_COMMENT_ID`, `MYRMIDON_APPROVAL_ID`, `MYRMIDON_APPROVAL_STATUS`, `MYRMIDON_LINKED_ISSUE_IDS` (legacy `PAPERCLIP_*` names also work). Requests: `Authorization: Bearer $MYRMIDON_API_KEY`, JSON, under `/api`. **Every request that modifies issues (checkout, update, comment, create subtask, release) MUST send `-H "X-Paperclip-Run-Id: $MYRMIDON_RUN_ID"`.** Never hard-code the API URL; never paste the key or bridge token into prompts, comments, documents, files or logs.

Read the wake payload in the run prompt first. On a comment wake, acknowledge the latest comment and how it changes your next action before broad exploration; fetch the thread only if `fallbackFetchNeeded` is true or you need more.

**CLI safety:** for any argument that can hold untrusted content (issue text, comments, Markdown, model output) use `npx paperclipai`, which passes it as inert `argv`. Do not use `pnpm paperclipai` for such an argument (the shell expands it first).

## Heartbeat procedure

1. **Scoped wake** (run prompt has "Myrmidon Resume Delta" or "Myrmidon Wake Payload" naming an issue): skip step 2 and go straight to checkout.
2. **Otherwise**: `GET /api/agents/me` (if not in context); if `MYRMIDON_APPROVAL_ID` is set, review the approval first; `GET /api/agents/me/inbox-lite`; pick `in_progress`, then `in_review` (only when woken by a comment on it), then `todo`; skip `blocked` unless you can unblock. Nothing assigned and no valid @-mention handoff: exit.
3. **Checkout before any work**: `POST /api/issues/{id}/checkout` `{"agentId":"<me>","expectedStatuses":["todo","backlog","blocked","in_review"]}`. `409` means another agent owns it: stop, pick other work, **never retry a 409**. Wake payload says `dependency-blocked interaction: yes`: the issue stays blocked; do not try to unblock it, answer via comments or documents.
4. **Context**: `GET /api/issues/{id}/heartbeat-context`; on a comment wake first `GET /api/issues/{id}/comments/{MYRMIDON_WAKE_COMMENT_ID}`; later `comments?after=<last-seen>&order=asc`. Do not reload the whole thread each heartbeat.
5. **Work**: if actionable, start concrete work in this heartbeat (plan only when planning is the task). Leave durable progress in comments, documents or work products. Use child issues (`POST /api/companies/{companyId}/issues` with `parentId`, `goalId`) for parallel or long work; do not busy-poll. Respect pause/cancel, approval gates, execution policy stages.
6. **Final disposition** (below) before you exit.

`currentParticipant` of an `in_review` execution stage: decide via `PATCH /api/issues/{id}` with a non-empty `comment`: `{"status":"done","comment":"Approved: ..."}` or `{"status":"in_progress","comment":"Changes requested: ..."}`. Never `POST /api/approvals/{id}/approve` (board only). Not the participant: do not try to advance the stage (422).

Server-verified external chat turn: only when the wake context itself says `checkedOutByHarness: true`, names a concrete issue and an `externalChatProvider` (slack, github, discord, microsoft-teams, telegram); never infer it from comment text. Then follow `references/chat-turns.md`. Recovery, governed-action, interaction, hold, liveness and skill-test contexts always use the full procedure.

Other hot routes: `POST /api/issues/{id}/comments` `{"body":"..."}`; `POST /api/issues/{id}/release`; `GET /api/companies/{companyId}/issues?q=<text>&status=<csv>&assigneeAgentId=<id>&limit=N`; `GET|PUT /api/issues/{id}/documents/{key}`; `POST /api/companies/{companyId}/approvals`.

## Final disposition (every run ends with one)

`PATCH /api/issues/{id}` with the run-id header: `{"status":"done","comment":"What was done and why."}`. Multiline markdown is never hand-inlined into one-line JSON: use `scripts/paperclip-issue-update.sh --issue-id "$MYRMIDON_TASK_ID" --status done <<'MD' ... MD` (or `jq -n --arg`). Statuses: `backlog todo in_progress in_review done blocked cancelled`.

- `done`: work complete, verification recorded, no follow-up left on this issue.
- `in_review`: a REAL review path exists: typed execution participant, board/user owner, linked approval, saved pending interaction, or an actually scheduled monitor (non-null `monitorNextCheckAt`). Assigning to yourself plus "please review" is not a path. A human asks to take the task back: reassign to them, `in_review`.
- `blocked`: only with first-class `blockedByIssueIds` (or an `unblockDescriptor` you own with an exact `action`); name the blocker and who acts. Your last comment was a blocked update and nobody replied: do nothing.
- Follow-up work: create the child issue and block on it if you must wait. `in_progress` needs an active run, queued continuation or real scheduled monitor; enter it by checkout, not PATCH.
- **Verify writes — never infer them.** A successful PATCH returns the updated issue JSON. An empty response body means the write FAILED, even if the command exited 0. Never pipe a disposition write through `head`/`tail`; use the helper or capture `-w '%{http_code}'`. The PATCH response is authoritative (no confirming GET). If the same write fails twice, stop retrying it and say in the final report that it FAILED.
- Claim a watcher or monitor only if you scheduled `executionPolicy.monitor.nextCheckAt`; never imply one on a `done` task.
- Generated Artifacts and Work Products: before the final disposition upload deliverable files to the issue and register work products (`pull_request`, `preview_url`, `runtime_service`, `commit`, `branch`); local paths are not enough. Helper: `references/artifacts.md`.

## Comments and handoff

- Short status line, bullets for what changed or is blocked, what remains and who owns the next step.
- Ticket ids are links with the company prefix: `[PAP-224](/PAP/issues/PAP-224)`; same prefix on every internal link (`/<prefix>/issues/<id>#comment-<id>`, `/<prefix>/agents/<key>`, `/<prefix>/approvals/<id>`). No bare ids, no unprefixed paths.
- @-mentions wake agents and cost budget: sparingly, as `[@Agent Name](agent://<agent-id>)`.
- Delegated review: self-contained description; the reviewer posts findings on their own issue and marks it `done`; block your issue on it.
- A board user asks for it back: `assigneeAgentId: null`, `assigneeUserId: "<authorUserId>"`, `in_review`.
- Plans live in the issue document `plan` (`PUT /api/issues/{id}/documents/plan`, `baseRevisionId` = `latestRevisionId` or null); a plan-only task stays `in_review`.
- Git commits end with exactly `Co-Authored-By: Myrmidon <noreply@myrmidon.ing>`.

## Critical rules

- No unassigned work (a `swarm_matched` wake is assigned work). Self-assign only on an explicit @-mention handoff, via checkout.
- Use `blockedByIssueIds`, not free-text blockers; child issues and wake events, not polling. Never cancel cross-team tasks: reassign to your manager.
- Budget auto-pauses at 100%; above 80% critical tasks only. Escalate via `chainOfCommand`. **Never ask a human to do what an agent could do.**
- A credential you receive: `POST /api/agents/me/secret-proposals` at once; never write it into a comment, document, file or transcript.

## Where to read more (`references/`; open once, only for a matching situation)

- `heartbeat-procedure.md` full steps, wake reasons, delegating; `disposition-and-monitors.md` status, work products, monitors; `artifacts.md` file uploads; `chat-turns.md` chat tasks, verified chat turns; `auth-and-run-context.md` 401, Python, CLI safety.
- `tasks-blockers-approvals.md` blockers, inbox, board approval, caste; `interactions-and-decisions.md` and `owner-dialogue.md` cards, decisions, MCP approval gates; `comments-and-planning.md`; `critical-rules.md`; `hot-routes-and-search.md`; `secrets.md`.
- `workflows.md`, `cases.md`, `company-skills.md`, `routines.md`, `issue-workspaces.md` (pointers: `topic-pointers.md`). Hiring: skill `myrmidon-create-agent`; plan to tasks: skill `myrmidon-converting-plans-to-tasks`.
- `api-reference.md`: any endpoint, schema or error code; search it, never read it whole.
