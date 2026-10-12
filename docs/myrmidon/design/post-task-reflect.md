# Post-task reflection: a lesson in the role's memory bank

> Russian version: [post-task-reflect.ru.md](post-task-reflect.ru.md)

Draft of 06.10.2026, for release 1.7, item POST-TASK-REFLECT of the
AGENT-EXCHANGE epic. This document fixes the design before the item is cut
into engineering parts: which events produce a "lesson", the shape of the
record in the role's memory bank, the deduplication rule, and the settings.
No code is written against this document yet; every mechanism named here is
grounded in modules that already exist in `main`.

## 0. Summary

- After three kinds of task outcomes — **return from acceptance**, **run
  error**, **`blocked`** — the board writes **exactly one** "lesson" entry
  into the **memory bank of the role** (the board `agents.role` value) of the
  agent that held the task.
- The lesson text comes from a short analysis by a **free model** (a model
  connection marked `free` in the model catalog), never from the run's own
  paid model. The analysis is one call, one paragraph, no tools.
- The record carries tags (`lesson`, the event kind, the task key), an expiry
  (`expires_at` in retain metadata), and the task reference as the retain
  `document_id`.
- Deduplication is deterministic: one lesson per (task, event kind, revision
  of the outcome) — a task returned twice produces two lessons, a sweep
  re-pass over the same outcome produces none.
- The feature is on/off per company from the UI without a restart, with a
  configurable time-to-live; both live in instance settings and are re-read
  on every event, following the agent-memory settings precedent
  (`general.agentMemory`, re-read per request).

## 1. Why a design document first

The item depends on two neighbours whose mechanics are still settling:
DEBATE-ASYM (role and judge mechanics) and BUDGET-CONFIG. Cutting straight
into code would freeze assumptions about "role bank" addressing and about
which model may be spent on reflection. This document freezes only what is
already true in the code (memory bank addressing, the retain API surface,
status-change hook points) and marks the rest as open questions with a named
owner of the decision — so the engineering cut can start on the stable parts.

## 2. Events that produce a lesson

An event is a durable state transition of a task or a run, observed by the
board server. Three kinds are in scope:

| Event | How the board sees it | Who the lesson belongs to |
|---|---|---|
| **Return from acceptance** | Issue status leaves `in_review` back to `in_progress` (a reviewer or the owner rejected the result; the review-routing module already tracks the return assignee) | The agent the task returns to (the return assignee), not the reviewer |
| **Run error** | A heartbeat run of the task's assignee ends in `error` (the auto-resume module already counts these and escalates after its attempt cap) | The agent whose run errored |
| **`blocked`** | Issue status becomes `blocked` with an unblock descriptor | The task's current assignee |

Out of scope (no lesson is written):

- successful completions and acceptances — a lesson about success is the
  skill-candidate path (SKILL-LIFECYCLE), not this one;
- cancellations, pauses, maintenance-window deferrals — no failure signal;
- repeated `error` of the same run under auto-resume retries: the event fires
  once per **final** failure (auto-resume gave up or was not applicable), not
  per attempt. The attempt cap of AUTO-RESUME is the natural cut: the lesson
  is written when the board gives up, because that is the moment the failure
  becomes a fact worth remembering.

Each event is consumed **once**, at the transition, by a hook next to the
code that performs the transition (the status patch path for returns and
blocks; the run-finalization path for errors). The hook enqueues an
outbox-style job; the analysis and the retain call run asynchronously so a
slow or down memory service never delays the status transition itself.

## 3. The lesson record

### 3.1 Which bank

The record goes to the **role bank**: `role-<companyId>-<role>` of the
assignee's board role (`agents.role`). Rationale:

- a lesson learned by one developer should be recalled by the next developer;
  the per-agent bank (`adapterConfig.hindsight.bankId`) would strand it;
- the role is already the addressing unit for caste grants and reviewer
  pools, so `role-…` banks reuse an existing, operator-visible naming
  surface;
- agents without a role (role is empty) get no lesson written — the event is
  logged and skipped, mirroring how an agent without a bank is a state, not
  an error, in the memory card.

Recall side: the bot profile's `adapterConfig.hindsight` block gains the role
bank as an additional recall source (read-only for the bot), so lessons reach
the next run of any agent with that role. The retain path stays write-only
from the board; bots never write lessons directly.

### 3.2 Record shape

One retain item per lesson, written through the same hindsight HTTP API the
memory plugin uses (`POST /v1/default/banks/{bankId}/memories`, one item,
`async: true`):

- **content** — the one-paragraph lesson text from the analysis model (see
  §4), English, first person of the role ("When a docs PR is returned with
  'X', check Y before resubmitting"), at most ~500 characters.
- **context** — `"paperclip"` (as the plugin already sends), keeping lessons
  in the same retention lane as other board-written memories.
- **document_id** — the task reference: `issue:<issueId>`. Hindsight groups
  and dedups by document id; this makes the task the anchor and makes "all
  lessons of task X" a document-scoped query.
- **metadata**:
  - `kind: "lesson"` (the applicability marker: recall filters on it),
  - `event`: `review_return` | `run_error` | `blocked`,
  - `issue_key`: the human key of the task,
  - `role`: the role the bank belongs to,
  - `expires_at`: ISO-8601 timestamp = event time + TTL (§5),
  - `dedup_key`: see §4.3,
  - `run_id` where the event is run-bound.
- **tags**: `["lesson", "post-task-reflect", "event:<event>", "role:<role>"]`
  — the tag set the memory card already displays.

Expiry is advisory metadata, not a hindsight feature: a daily sweep
invalidates (`state: invalidated`, reason `ttl-expired`) lesson records whose
`expires_at` has passed. Soft invalidation matches the memory card's removal
semantics and keeps the service-side audit trail.

## 4. Analysis, dedup, and failure behaviour

### 4.1 The analysis call

One call to a free model: the input is the task title, the last reviewer
comment / the run's error summary / the unblock descriptor (whichever fired
the event), and at most the last N=5 comments of the thread, truncated. The
prompt asks for one paragraph: what went wrong, what to do differently, stated
as guidance for the role. The model is picked from the instance's model
catalog among connections marked `free` (the catalog flag the
model-providers module already exposes); with no free model configured the
feature degrades to a **template lesson** (event kind + reason text, no
analysis) rather than spending a paid model — the setting in §5 controls
whether degradation is allowed.

### 4.2 Exactly-once per outcome

The outbox job carries the `dedup_key`:

```
<issueId>:<event>:<outcomeRevision>
```

- `review_return`: revision = the count of returns of this issue (kept in the
  execution state; the review-routing state already versions stages),
- `run_error`: revision = the failed run id,
- `blocked`: revision = the blocked-at timestamp of the transition.

Before retaining, the worker lists the role bank filtered by the
`document_id` of the task and skips the write when an item with the same
`dedup_key` exists (valid or invalidated). Deterministic keys, not semantic
similarity: two genuinely different failures of one task produce two lessons,
one failure processed twice produces one. The acceptance criterion "a return
from acceptance creates exactly one lesson record" is a test on this path:
fire the transition twice (the second time from a sweep re-pass), assert one
record.

### 4.3 Failure behaviour

- Memory service down or retain failed: the job retries with backoff inside
  the run of the worker tick, then gives up and writes an activity-log row
  (`myrmidon.reflect.retain_failed`). The status transition that caused the
  event is never rolled back and never waits.
- Analysis call failed or no free model and degradation off: same outbox
  retry; on final failure the event is dropped with the same log row. No
  partial records: the retain happens only after the analysis succeeded.
- Every written lesson and every final failure writes one activity-log row
  (the memory module's audit convention: bank id, task key, dedup key — never
  the lesson text).

## 5. Settings (UI, no restart)

New instance settings under `general.postTaskReflect`, re-read on every
event, each shown in the UI with its source (setting / env / default) exactly
as the agent-memory settings do:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off = no events are enqueued, no records are written, without a restart (acceptance criterion: switching off mid-flight stops new records) |
| `lessonTtlDays` | `90` | Time-to-live of a lesson record, 1–365. The expiry sweep invalidates past-due lessons |
| `allowTemplateFallback` | `true` | With no free model available, write a template lesson instead of dropping the event |
| `maxLessonsPerDay` | `20` | Per-company spend ceiling on analysis calls (BUDGET-CONFIG alignment); at the cap, events are dropped with a log row until the next day |

Env overrides (`MYRMIDON_POST_TASK_REFLECT_*`) exist only as forced overrides
and lose to the instance setting, per the standing settings rule. The toggle
lives in the current UI (Instance settings → General), next to the agent
memory panel; no new-interface screens.

## 6. Acceptance criteria (from the item, mapped to tests)

- **A return from acceptance creates exactly one lesson record** — test on
  the dedup path (§4.2): transition fired twice, one record in the bank, the
  second pass a no-op.
- **With the setting off there are no records, without a restart** — test:
  feature on → event → one record; flip `enabled` to `false` in the instance
  setting (no process restart); fire the same event on another task → no new
  record, no enqueued job.

## 7. Dependencies and open questions

- **DEBATE-ASYM** owns whether a judge verdict (as opposed to a human/owner
  return) is a fourth event kind. The design admits it as one more `event`
  value with the same record shape; the engineering cut adds it when
  DEBATE-ASYM lands.
- **BUDGET-CONFIG** owns whether `maxLessonsPerDay` joins a shared budget
  envelope instead of a standalone counter. The setting shape above is
  compatible with either.
- **SKILL-LIFECYCLE** stays the path for positive lessons (skill candidates);
  a lesson record whose text is later promoted into a skill candidate is
  invalidated with reason `promoted-to-skill` to keep recall clean. That
  linkage is a follow-up, not part of this item.

## 8. Risks

- **Bank pollution.** A chatty failure mode (a flaky tool erroring every run)
  fills the role bank with near-identical lessons. Mitigations in the design:
  dedup by run id does not help there, but `maxLessonsPerDay` caps the flow,
  the TTL sweep ages them out, and the memory card already lets an operator
  invalidate entries. A per-`dedup-key`-prefix rate limit is the documented
  follow-up if the cap proves too coarse.
- **No free model configured.** With `allowTemplateFallback: false` the
  feature silently does nothing; the activity-log row and the settings panel
  status line are the operator's signal.
- **Role renaming.** Banks are named by the role string; renaming a role
  strands the old bank (recall looks at the new name). Roles are
  operator-managed and renamed rarely; the memory card per agent is
  unaffected. Recorded here as a known limitation, not solved in this item.
