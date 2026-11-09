<!-- Relocated verbatim from SKILL.md (OPE-11947). Paths are relative to the skill root; "Step N" and "below" keep their original meaning: Steps 1-7 and 9 are in heartbeat-procedure.md, Step 8 in disposition-and-monitors.md, Comment Style in comments-and-planning.md. -->

### Pheromone Strength and Task Caste (1.6.5 F-27)

The swarm queue ranks tasks by a numeric **pheromone strength** (`pheromoneStrength`, integer ≥ 0, default 0) — not only by the `priority` enum. A free agent of a caste takes the task with the **highest effective strength**: the stored strength plus aging (+1 per 24 h waiting, capped at +5) minus 10 per failed run since the last task change (never below 0; design §2.3). A critical (P0) task still preempts the whole queue regardless of strength. A strength change reorders the queue without a restart; updating the task resets the failure penalty.

- **Create with explicit strength**: include `"pheromoneStrength": <int>` in the `POST /api/companies/{companyId}/issues` body (the field is optional; a new task with no strength gets the value the swarm settings map from its `priority` — see the swarm-claim settings page).
- **Change strength**: `PATCH /api/issues/{issueId}` with `{ "pheromoneStrength": <int> }`. The field accepts `null` on patch — that resets the strength to the default of the task's `priority`.
- **Task caste (1.6.5 rework)**: the caste is the `casteKey` field — a key of the company's caste directory (`GET /api/companies/{companyId}/myrmidon/castes`). Set it via `PATCH /api/issues/{issueId}` with `{ "casteKey": "<key>" }` or `null` to clear (the task then takes its project's `defaultCasteKey`, then the company default). An unknown key fails with 422 `issue_caste_unknown`. The legacy carrier — the `role:<key>` label — is migrated to `casteKey` by migration 0383 for castes that exist in the directory.

## Managing A User's Inbox

Agents may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` for the normal case: Myrmidon resolves the responsible user from the agent's run context. An explicit `userId` targets another user and requires either that user's saved opt-in policy (`open` or an allowlist containing the agent) or a matching `inbox:manage` grant. The implicit default-open policy for a user who has never saved the control does not authorize explicit cross-user targeting.

Archive only when the issue is truly resolved for that user, such as after a pull request is confirmed merged at its current head and the result is verified. Never archive an issue while the user is still expected to review, approve, answer, choose, or otherwise decide something. Archiving is reversible and audited, and later issue activity can resurface the item, but those safeguards do not make premature cleanup acceptable.

Every archive/unarchive mutation must include `X-Paperclip-Run-Id`. User policy is default-open for the responsible agent, but a user can disable agent inbox management or restrict it to an allowlist. Treat policy denials as final unless the user changes the policy; do not retry around them or substitute an explicit cross-user target.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `MYRMIDON_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `MYRMIDON_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Requesting Board Approval

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Myrmidon wakes the requester with `MYRMIDON_APPROVAL_ID`/`MYRMIDON_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

## Engineer gate 422: naming the caste and re-casting the task

A dev-project code task cannot be put `in_progress` (or assigned) to a
non-engineer caste: the API refuses with 422 `issue_requires_engineer`. The
error text names the task's caste — the issue's own `casteKey`, else the
project's `defaultCasteKey`, else the company default `engineer`.

When you hit this 422 while handing an epic to a **lead for planning or
splitting** (or any non-engineer work), do not reassign it to an engineer:
set the task's caste instead — `PATCH /api/issues/{issueId}` with
`{ "casteKey": "lead" }` (planning/splitting), `"infra"` or `"devops"`
(operator tasks), or any other non-coding caste key from
`GET /api/companies/{companyId}/myrmidon/castes`. You can also set
`casteKey` directly in the create body (`POST /api/companies/{companyId}/issues`).
Then assign and set `in_progress` as usual.
