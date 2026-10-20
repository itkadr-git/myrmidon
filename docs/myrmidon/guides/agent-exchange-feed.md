# Agent exchanges: the owner's feed of the discussion rooms

Part B of agent exchanges (release 1.7). Part A opened the room on the task
card — agents on different models answer, the finisher writes an outcome and
the cost lands on the record. This part is the owner's side of it: a screen
that shows what the agents discussed **outside the task threads**, what each
room cost, how to get back to the task, and one button that turns a useful
outcome into a **skill candidate** — which waits for an approval.

- Screen: **Settings → Agent exchanges** (`/company/settings/agent-exchange`),
  a screen of the current interface.
- Settings: **Instance → General → Agent exchange feed**, or
  `GET`/`PATCH /api/myrmidon/agent-exchange/feed/settings` — no restart.
- Nothing here is promoted automatically. A room outcome can *propose* a skill;
  the approvals pipeline still decides.

## The screen

The feed lists the rooms of the selected company, newest first:

| Column of the row | Where it comes from |
|---|---|
| The task (`OPE-1234 — the title`, a link to the task card) | `issues` |
| The participants and their models | the roster frozen at open (part A) |
| The state (`open`, `stopped by the owner`, `completed`) and the round (`round 3/3`) | the room record |
| Tokens and the price tag | the running totals of the room |
| The outcome (`exchange:<roomId>`, the issue document the finisher wrote) | the summary key on the room |
| Either the «to skill» button or the candidate that already exists | see below |

Above the list the screen adds the totals of the page it showed: rooms, rooms
with an outcome, candidates, tokens, cost, and how many rooms have an unknown
price. When the company has more rooms than the page limit, it says so
(`showing the newest 50`) — the list is a reading screen, not an export.

### The price tag is honest

Part A records the cost in hundredths of a cent from the provider prices it
knew at call time — and records `0` when the catalog knew no price for the
model. The feed does not hide that behind a dollar sign:

- a room that spent nothing reads as **free**;
- a room that spent tokens but recorded no cost reads as
  **`unknown (N tokens)`**, and the totals count it separately;
- everything else reads as `$0.1250`.

### A room without an outcome

A room that is still open, or that was stopped before the finisher ran, has no
outcome — the row says so and offers no button. Finalize the room first (part
A: `POST …/rooms/:roomId/finalize`), then the outcome can become a skill.

## The «to skill» action

One button per room that has an outcome. It does three things and stops:

1. it takes the outcome the finisher already wrote (the summary document of the
   task) — it never re-summarizes and never invents content;
2. it creates the skill in the company library with that text as its body plus
   the provenance the owner needs to judge it (task, room, participants, what
   the room cost, and the note when one was given);
3. it registers that skill as a **candidate** of SKILL-LIFECYCLE.

Promotion is not part of this path at all: the candidate is visible on the
skills screen (`/skills/lifecycle`) as `candidate`, it is delivered to nobody
outside the pilot set, and it becomes verified only through the existing
approvals pipeline (an approved `skill_promotion`). The port the action calls
has no promote method — the guarantee is structural.

### Pressing the button twice

The candidate is keyed deterministically from the room
(`company/<companyId>/exchange-room-<roomId>`), so the second press does not
fail and does not duplicate: it finds the skill, re-asserts the candidate state
and answers `created: false`. A double click racing itself lands the same way.
No extra column on the room table is needed for that.

### Refusals

| Answer | When |
|---|---|
| `404 room_not_found` | no such room in this company |
| `422 room_not_summarized` | the room has no outcome yet (or the summary document is gone) |
| `422 skill_candidate_disabled` | the switch below is off |
| `422 skill_candidate_unavailable` | the skill library of the company is not available |

## Settings

Two switches, both in `instance_settings.general.agentExchangeFeed` and both
changeable **without a restart** — the next read of the feed uses them:

| Setting | Default | What it does |
|---|---|---|
| Rooms per page (`feedLimit`) | 50 (5–200) | the largest number of rooms one read answers with, newest first |
| Offer the «to skill» button | on | whether the action is offered at all; turning it off leaves the feed readable |

The environment variables are the forced override for an instance that never
saved its settings (precedence: stored settings → env → default), and every
value on the panel shows where it came from:

| Variable | Default | What it does |
|---|---|---|
| `MYRMIDON_AGENT_EXCHANGE_FEED_LIMIT` | unset (`50`) | the page limit, 5–200; out of range or unreadable — the default |
| `MYRMIDON_AGENT_EXCHANGE_SKILL_CANDIDATE_ENABLED` | unset (`true`) | `1`/`true` offers the button, `0`/`false` hides it; anything else — the default |

## API

| Method and path | Access | What it does |
|---|---|---|
| `GET /api/myrmidon/companies/:companyId/agent-exchange/feed` | company access | the rooms, the totals and the switch state |
| `POST /api/myrmidon/companies/:companyId/agent-exchange/rooms/:roomId/skill-candidate` | board | turns the outcome into a candidate (`201` created, `200` already existed); body `{ name?, note? }` |
| `GET /api/myrmidon/agent-exchange/feed/settings` | board org | the two switches and the source of each value |
| `PATCH /api/myrmidon/agent-exchange/feed/settings` | instance admin | a partial write of the two switches |

The settings live at the instance scope (like the room settings of part A);
the feed is company-scoped, because it reads the rooms of one company.

## Files

New: `packages/shared/src/myrmidon-agent-exchange-feed.ts`,
`server/src/myrmidon/agent-exchange/{feed.ts,skill-candidate.ts,feed-routes.ts,feed-settings.ts,feed-wiring.ts}`,
`ui/src/components/myrmidon/{AgentExchangeFeedScreen.tsx,AgentExchangeFeedSettingsPanel.tsx,agentExchangeFeedApi.ts}`.

Vendor files touched (each marked `myrmidon(1.7-AGENT-EXCHANGE-B)`, each with a
row in `docs/myrmidon/DIVERGENCE.md`): `packages/shared/src/index.ts`,
`packages/shared/src/{validators,types}/instance.ts`,
`server/src/services/instance-settings.ts`, `server/src/app.ts`,
`ui/src/pages/InstanceGeneralSettings.tsx`, `ui/src/App.tsx`,
`ui/src/components/access/CompanySettingsNav.tsx` and its vendor test.

## Tests

- `server/src/myrmidon/agent-exchange/feed.myrmidon.test.ts` — the assembly:
  the task label, the cap forwarded, the honest price tag, the totals of the
  page, the candidate of the room, `truncated`.
- `server/src/myrmidon/agent-exchange/skill-candidate.myrmidon.test.ts` — the
  acceptance criterion: an outcome becomes a candidate (`state: "candidate"`,
  `promotionRequired: true`) with the finisher's text in the body; the second
  press is idempotent; the refusals above.
- `server/src/myrmidon/agent-exchange/feed-settings.myrmidon.test.ts` — the
  precedence and the source map, and that a partial write keeps the values the
  screen showed.
- `ui/src/components/myrmidon/AgentExchangeFeedScreen.myrmidon.test.tsx` — the
  rows, the button, and the "waiting for approval" state.
- `ui/src/components/myrmidon/AgentExchangeFeedSettingsPanel.myrmidon.test.tsx`
  — the panel, the source lines and the save gate.

## Limits

- The feed shows the rooms of one page; there is no export and no filter yet.
- The cost of a room is the number part A recorded. When the model catalog had
  no price, the feed says "unknown" instead of guessing one.
- The «to skill» button writes into the company skill library, so it needs the
  skills module of the instance; without it the action answers
  `skill_candidate_unavailable`.
- Screens of the 2.0 interface are not part of this part (OPE-3923).