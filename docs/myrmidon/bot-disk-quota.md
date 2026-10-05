# Per-bot disk quota (1.6.1-BOT-DISK-C)

> Русская версия: [bot-disk-quota.ru.md](bot-disk-quota.ru.md)

On 03.10 the host disk filled to 100% and the board fell over: dozens of bot
volumes (each holding workspace clones, scratch dumps and the bot's hermes
directory) had no limit. This feature gives every bot a disk quota so one bot's
runaway clone can no longer take the whole host down.

## What is measured

A bot owns one directory on the host that runs its containers:

```
<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>/{hermes,workspace,scratch}
```

(`botKey` is the agent id; see [host-disk.md](host-disk.md) for the layout.)
That directory's total size is the bot's usage. The measurement walks the tree
like the workspace-hygiene measure does: symlinks are measured but never
followed, hardlinked files (the shared pnpm store imports them) are counted
once per bot, and a huge or very deep volume stops at caps (200 000 entries,
depth 32, 5 s) — a stopped walk reports a lower bound, never an error.

When the board's server does not run on the host that holds the bot volumes
(a fleet host), `MYRMIDON_BOT_VOLUME_ROOT` is not visible there and the feature
is inert: no measurement, no card, no refusal. The same for an unsaved quota.

## Settings

`general.botDiskQuota` in the instance settings, set without a restart from the
"Per-bot disk quota" panel on the instance general settings page, or through the
API (`PATCH /api/myrmidon/bot-disk-quota`, instance admins only, audited as
`instance.bot_disk_quota.updated`):

| Field | Meaning |
|---|---|
| `defaultQuotaMb` | quota for every bot of the company (the "caste default") |
| `perCaste[]` | `{casteKey, quotaMb}` matched against `agents.role` — a whole caste gets a different quota |
| `perAgent[]` | `{agentKey, quotaMb}` — one bot, wins over the caste entry |
| card `container.diskQuotaMb` | per-bot override on the agent card; wins over all of the above |

The first found value applies (card → perAgent → perCaste → default). No value
for a bot means no limit for that bot. Every bot's quota is re-resolved at each
workspace admission check and on each sweep measurement, so saving changes
behaviour immediately: no restart, no re-apply of cards.

An invalid stored value reads as "off" (fail-closed) — a broken setting can
never block work nor raise a card.

## Signals and refusal

- A bot whose usage is ≥80% of its quota (but not over) raises an attention
  card of source kind `bot_disk_quota` ("Bot disk quota") in the board's
  attention queue. It carries the measured usage, the limit and the percent, so
  the fix is visible without opening the settings.
- A bot over its quota raises the same card with "quota exceeded" wording, and a
  NEW execution workspace for it is refused before its directory is created:
  `realizeExecutionWorkspace` aborts with
  `BOT_DISK_QUOTA_EXCEEDED: <name> has used <used> MB of its <quota> MB disk
  quota, so a new workspace clone is refused. Remove unneeded worktrees, build
  outputs and caches under your volume, then retry.`
  An existing workspace is never refused or deleted by the quota: a bot keeps
  working in what it already has while the attention card asks for cleanup —
  the refusal only stops the growth. The same rule keeps the host alive: a bot
  cannot clone itself into a full disk, and the board (which is not under the
  quota) keeps serving.

The card is a signal, not a ticket: while the bot stays over/at the level, each
sweep pass (a bot is remeasured at most once every 10 minutes) renews it — the
dedup key is the bot id, so re-raising refreshes the same card instead of
stacking. When the usage drops below 80% —
after a cleanup, a draft reap or a lowered setting — the sweep drops the signal
and the card closes.

## The sweep

The maintenance tick (`server/src/index.ts`, one line: `scheduleBotDiskQuotaSweep()`)
measures one page of bots per tick (20 by default, ordered by the last activity)
and rotates through all bots; the page cursor resets after the last bot. A bot
measured less than 10 minutes ago is not measured again on the next tick (its
last signal stands), so a tick never walks the same directory twice in a row.
A failed bot (unreadable volume) counts into the sweep's `failed` and is retried
on its next turn; the sweep logs its totals per tick.

The measured `lastSweep` is returned by `GET /api/myrmidon/bot-disk-quota` and
shown under the panel, so the operator sees what the sweep is doing without
opening the server log.

## What the quota does NOT do

- It does not delete anything. Reaping abandoned drafts is BOT-DISK-A
  (`general.botDisk`, idle-TTL sweep); this feature only accounts and refuses.
- It does not throttle writes inside a running workspace. A bot already inside
  its clone can keep writing until the host allows — the quota stops the next
  clone from making the same mistake bigger.
- It does not touch fleet-host bots (the board cannot see their disk; inert).

## Bot-facing error code

Stable string: `BOT_DISK_QUOTA_EXCEEDED:` — the same contract as the other
workspace admission refusals (`WORKTREE_MISSING:` …). A bot may match on it.
