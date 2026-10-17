# Telegram group topics as a task inbox (topic inbound)

> Russian version: [telegram-topic-inbound.ru.md](telegram-topic-inbound.ru.md)

In a Telegram supergroup with forum topics enabled, every message a user
writes in a topic can become work on the Myrmidon board: the board either
continues the task already bound to that topic or creates a new task from the
message. The feature is off by default — a fresh install behaves exactly like
the vendor path, and topic messages that are not mentions of the bot stay
ignored.

The two switches live in the `telegramNotify` settings document and are
runtime-changeable, no restart and no environment variables:

| Setting | Default | What it does |
|---|---|---|
| `telegramNotify.inbound.enabled` | `false` | Master switch. With `false` a topic message never becomes task work and the vendor path is byte-for-byte unchanged |
| `telegramNotify.inbound.requireMention` | `true` | With inbound enabled, a topic message the adapter did not mark as a mention or a reply to the bot stays ignored — the group privacy contract. Commands in a topic then work only when the bot is addressed, as in a DM. `false` admits any topic message |

Editing: on the System screen of the 2.0 UI (Settings → System), the
"Telegram notifications" panel, section "Owner messages" (`inbound`). Saving
sends one `PATCH /api/myrmidon/telegram-notify` with the changed fields; the
saved document takes effect on the next incoming message.

## What the board does with an admitted message

- **The topic is already bound to a task.** The message continues the bound
  conversation — the agent that owns the task sees it as the next inbound
  message, exactly as a message in a bound DM.
- **The topic is not bound.** The board creates a new task: the title is the
  first words of the message (first line, bot mentions stripped, capped at
  160 characters; an empty or mention-only message falls back to a neutral
  "Telegram topic message" title), and the body carries the full message text
  plus an origin line with the link to the Telegram thread, so the task
  always points back to the topic.

With `requireMention` on (the default) none of this happens for a message
that does not address the bot: it stays in Telegram only, no task, no
comment, no log noise.

## Requirements and notes

- The group must already be an enabled destination of a connected Telegram
  endpoint (the vendor's admission decides reach); the inbound gate only adds
  the two settings on top.
- Only forum-topic threads are covered. A message in the group's root (a
  non-forum group, or the "General" section) keeps the vendor's mention
  rules.
- A stored document with a missing or malformed value falls back to the safe
  defaults: a non-boolean `requireMention` reads as `true`, and anything that
  is not exactly `enabled: true` reads as off — a hand-edited or partial
  document can never turn inbound on by accident.
- Reading the settings happens per message and costs one instance-settings
  row read; with the feature off and no stored document the vendor path is
  untouched.

## Related

- [telegram-multi-agent.md](telegram-multi-agent.md) — addressing agents from
  one Telegram chat with `@`-mentions and `/to`; the same mention rules apply
  inside topics when `requireMention` is on.
- [SETTINGS.md](../SETTINGS.md), section "TG-NOTIFY topic inbound (part D)" —
  the settings table with defaults and fallback rules.
