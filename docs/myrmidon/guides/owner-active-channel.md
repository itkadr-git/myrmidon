# Owner active channel: reports follow the owner between portal and Telegram (1.7-ACTIVE-CHANNEL)

> Русская версия: [owner-active-channel.ru.md](owner-active-channel.ru.md)

The owner talks to the board through two channels: the portal (the board UI,
a logged-in session) and the Telegram DM bridge (the standing X8b
conversation). A report — the Commander's answer, a plan response, an agent's
question or confirmation card — should arrive where the owner actually is,
not where the interface guessed they were. Until this feature the rail footer
said "Web · now" as a hardcoded literal and there was no status API at all.

The board now marks the owner's last activity per channel and routes each
report card to the channel that is active at the moment the card is created.

## How activity is marked

Two touch points, one small table (`myrmidon_owner_activity`, one row per
board user and channel):

- **Portal (`web`)** — every request authenticated with a user session marks
  the `web` channel. The write is debounced (at most one per user per 30 s)
  and fire-and-forget: a failed touch never fails the request and is not
  awaited by it.
- **Telegram (`telegram`)** — an inbound message in a bridged Telegram DM
  (the X8b path, a linked owner) marks the `telegram` channel, also
  fire-and-forget, right after the comment lands.

The table stores only a user id, a channel name and a timestamp — no message
content.

## What "active" means

A channel is active while its last touch is fresher than the **inactivity
threshold** (default 120 minutes). The active channel is the freshest touch
within the threshold; the portal wins an exact tie. When every touch is older
than the threshold, no channel is active.

Delivery of report cards (questions and confirmations created by an agent on
a task that has no chat binding of its own) follows the active channel:

- **active in Telegram** — the card goes to the owner's standing Telegram DM
  with the authoring agent (the U2 path);
- **active in the portal** — the card stays board-only: an owner who is
  reading the board today reads the card on the board, and pulling the report
  into Telegram while they sit in the portal is the wrong direction;
- **no channel active** — the standing U2 rule: Telegram wins, so a card
  still reaches a passive owner off-portal.

The vendor's own task-thread bindings always take precedence: a task that
lives in a chat conversation keeps delivering into that thread, and this
feature never mirrors it elsewhere.

## API

`GET /api/myrmidon/owner/active-channel` answers the status for the calling
board user:

```json
{
  "channel": "telegram",
  "lastActiveAt": { "web": "2026-10-05T09:55:00.000Z", "telegram": "2026-10-05T11:59:00.000Z" },
  "thresholdMin": 120,
  "thresholdSource": "default"
}
```

`channel` is `"web"`, `"telegram"` or `null`. `thresholdSource` names where
the effective threshold came from: `settings` (saved on the instance settings
row), `env` (the forced environment override) or `default`. An instance admin
may ask about any user with `?userId=`; a plain board member only reads their
own status.

`PATCH /api/myrmidon/owner/active-channel` (instance admin) changes the
threshold:

```json
{ "thresholdMin": 30 }
```

The body is validated to an integer in 5–10080. The change writes
`instance_settings.general.ownerActiveChannel`, records the change in the
activity log of every company and drops the readers' short cache — the next
delivery decision already uses it. No restart.

## Setting the threshold in the interface

Instance → General → "Owner active channel" panel: the field shows the
current threshold, the source of its value ("Saved here" / "Forced by the
server environment" / "Default"), the owner's current active channel, and a
Save button. Saving takes effect without restarting the server.

`MYRMIDON_OWNER_ACTIVE_THRESHOLD_MIN` is a forced override only: while it is
set, the panel shows "Forced by the server environment" and the field is
disabled. Unset the variable to hand control back to the saved value.

## What the shell shows

The 2.0 rail footer and the phone header render the live status
(`useOwnerActiveChannel`, polled every 30 s): "Active · Web", "Active ·
Telegram", or "Active · not seen recently" when no channel is within the
threshold. The old literals ("Web · now", "Owner · Web") are gone.

## Tests

- `packages/shared/src/myrmidon-owner-active-channel.myrmidon.test.ts` —
  threshold precedence, clamping, the active-channel decision.
- `server/src/myrmidon/owner-active-channel/routes.myrmidon.test.ts` — GET/
  PATCH permissions, the source shown, the audit row, the live effect of a
  PATCH.
- `server/src/__tests__/owner-active-channel.myrmidon.test.ts` — embedded
  Postgres acceptance: an owner message in Telegram makes Telegram the active
  channel and the card goes there; portal activity keeps the card board-only;
  lowering the threshold through the service flips the next decision without
  a restart.
- `server/src/__tests__/owner-telegram-delivery.myrmidon.test.ts` — the
  standing U2 path still behaves byte-for-byte with no activity touches.

## Removal

Delete the `server/src/myrmidon/owner-active-channel/` module, the shared
contract `packages/shared/src/myrmidon-owner-active-channel.ts`, the db
schema file and its migration, the panel and hook in `ui/`, and the pieces
marked `myrmidon(1.7-ACTIVE-CHANNEL)` in the vendor files; the U2 path can
move back to `server/src/myrmidon/owner-delivery/`.
