# Custom castes — the company agent-role directory

> Russian version: [custom-castes.ru.md](custom-castes.ru.md)

Every agent on the board carries a role — the string in `agents.role` that
decides which swarm queue its tasks land in and which permissions apply.
Before this feature the role had to be one of twelve built-in names. Custom
castes replace that fixed list with a per-company directory the board owns:
the company starts from the same twelve entries and can then create its own,
rename them, tune each one's behavior, and delete the ones it does not need.

This guide covers the directory itself: where it lives, what a caste is made
of, the API, and what happens to agents and their tasks when a caste changes.

## Where it lives

- **In the database.** The directory is a table (`agent_castes`) scoped to the
  company: each company has its own set of castes, and deleting a company
  deletes its castes with it. There are no environment variables and no
  instance settings behind the feature.
- **In the UI.** Company settings carry the directory as the "Agent castes"
  screen. Agents are still assigned a role in the agent editor — the only
  difference is that the role is now a caste key from this directory, so a
  caste you just created is immediately assignable.
- **In the API.** `GET/POST /api/myrmidon/companies/:companyId/castes`,
  `PATCH/DELETE /api/myrmidon/companies/:companyId/castes/:key`.

The directory is read from the database on every request — there is no
process cache and nothing to restart. A caste the board creates, edits, or
deletes is visible to the swarm's claim gate and to every client on the next
call.

## The starting set: twelve built-in castes

The first time a company's directory is read, it is seeded with the twelve
built-in castes — the same roles the fixed list had (`ceo`, `engineer`, and
the other ten), with their English and Russian names, `swarmEligible: true`,
no per-caste task ceiling (`maxActiveTasks: null` — the global swarm limit
applies), and the badge color spread deterministically over the palette.
Seeding is idempotent: it inserts only the keys the company is still missing,
so it never overwrites entries you created or edited.

Built-in castes are marked `builtIn: true`. They behave like any other caste
except that the flag itself is immutable (see below). Existing agents keep
their current roles untouched — the seed does not rewrite `agents.role`.

## What a caste is

| Field | Type | What it is |
|---|---|---|
| `key` | string | The stable identifier — latin letters, digits, hyphens and underscores, 1–60 characters, lowercased. This exact string is what an agent carries in `agents.role`. Immutable once created. |
| `nameEn` | string | English display name, required, up to 160 characters. |
| `nameRu` | string or null | Russian display name, up to 160 characters. |
| `description` | string or null | Free-form description, up to 2000 characters. |
| `color` | string | Badge color from the status palette: `primary`, `muted`, `blue`, `amber`, `green`, `violet`, `red`, `gray`. Defaults to `gray`. |
| `icon` | string or null | Optional icon identifier, up to 64 characters. |
| `defaultModel` | string or null | The model an agent of this caste defaults to, up to 512 characters. |
| `swarmEligible` | boolean | Whether agents of this caste enter the swarm claim pool. `true` by default; a supervision caste such as a lead or an on-call reviewer is created with `false` so the swarm never hands it a task. |
| `maxActiveTasks` | integer or null | Per-caste ceiling of active swarm tasks, 1–1000. Overrides the global `MYRMIDON_SWARM_MAX_ACTIVE_TASKS` for agents of this caste only; `null` keeps the global ceiling. |
| `builtIn` | boolean | Set by the seed, not settable through the API. Immutable. |

Every caste in a response also carries `createdAt` and `updatedAt` timestamps.

## API contract

All four routes are under the company: another company gets a 403, and reads
are open to any actor with company access (agents of the company can read the
directory). Mutations — create, update, delete — are board-only.

| Route | Access | Behavior |
|---|---|---|
| `GET /api/myrmidon/companies/:companyId/castes` | company access | Answers `{ castes: [...] }`. The first read of a company seeds the twelve built-ins before answering. |
| `POST /api/myrmidon/companies/:companyId/castes` | board | Creates a caste, answers `201` with the created entry. A `key` the company already has is a `409`; an invalid key shape, a missing `nameEn`, or a color outside the palette is a `400`. |
| `PATCH /api/myrmidon/companies/:companyId/castes/:key` | board | Updates mutable fields, answers `200` with the updated entry. A body carrying `key` (with a different value) or `builtIn` is a `400` — both are immutable. A body with no mutable field at all is a `400` as well. An unknown caste key is a `404`. |
| `DELETE /api/myrmidon/companies/:companyId/castes/:key` | board | Deletes the caste, answers `204`. See "Deleting a caste" below for the `reassignTo` contract. |

Error bodies carry a machine-readable `code` next to the message — for
example `caste_key_immutable`, `caste_builtin_immutable`, `caste_has_agents`,
or `caste_reassign_target_missing` — so a client can react without parsing
text.

## Deleting a caste and reassigning agents

Deleting a caste with no agents on it is unconditional: the row is removed
and the answer is `204` (a `reassignTo` body is ignored).

A caste that still has agents cannot simply disappear:

- `DELETE` without a body answers `409` (`code` `caste_has_agents`, with the
  count of affected agents in `affected`) — the directory refuses to strand
  agents on a role that no longer exists.
- `DELETE` with `{"reassignTo": "<key>"}` moves every agent of the company
  whose role is the deleted key over to the target caste and deletes the row,
  in one transaction. The target must exist in the same company and differ
  from the deleted key, otherwise the answer is a `400`.

The swarm's role queues are built from `agents.role`, so the reassigned
agents' queued tasks follow them into the target caste's queue automatically —
no separate queue rewrite happens, and nothing needs a restart to take
effect.

## How the rest of the system uses the directory

- **Agent create/update** validate `role` against the directory: assigning a
  key that is not a caste of the company is refused with a `400`
  (`role_not_company_caste`). Create the caste first, then assign it. The
  board UI shows the raw key for any role outside the built-in label map.
- **The swarm claim gate** consults the caste before handing out a task:
  `swarmEligible: false` answers the claim with `caste_excluded`, and a
  caste-level `maxActiveTasks` caps that caste's agents independently of the
  global limit. A role with no directory entry behaves exactly as before the
  feature.
- **Unchanged on purpose:** the autonomy matrix resolves the caste key as the
  role string with no schema change, the built-in `ceo` checks are
  byte-identical to before, and cloud-connector grants by caste are
  untouched.

Every mutation writes one entry to the company's activity log
(`caste_created`, `caste_updated`, `caste_removed`, or
`caste_removed_reassigned` — the latter naming the target caste and the
number of reassigned agents).
