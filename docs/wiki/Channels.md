# Telegram and channels

> Русская версия: [Channels.ru](Channels.ru)

The owner does not have to live in the board UI: Myrmidon bridges to
Telegram, so questions, decisions and daily summaries arrive where the owner
already reads messages.

## The DM bridge

A Telegram DM bridged to the board lets the owner talk to the company's
agents directly. One bridged chat can address any agent of the company: a
`@`-mention in the message text routes that one message to the mentioned
agent, and the `/to` command sets a sticky default addressee for the chat.
Service texts (command replies, refusals, status lines) follow the language
of the linked board user, and the run status line and long answers can be
shown as editable, split messages (opt-in settings).

## Decision cards in Telegram

When an agent needs the owner's decision — a question card or a
confirmation card on a task — the card is delivered to the owner's Telegram
and the owner answers it there; the answer lands on the task as if it had
been given in the board UI.

## Digests and escalations

Two periodic jobs write to the owner's Telegram, both off by default: a
daily digest of what the team did and escalations when something waits on
the owner past a threshold. What the jobs send and when is tuned in the
owner's Telegram notification settings; delivery goes through the board's
normal chat publication path.

## Group topics as a task inbox

In a Telegram supergroup with forum topics enabled, every message written in
a topic can become work on the board: the board either continues the task
already bound to that topic or creates a new task from the message. The
feature is off by default — a fresh install behaves exactly like before.

## The planning entry

The board's chat planner is reachable from Telegram too: the owner describes
what is wanted, and the proposed epic comes back as an approval card (see
[Tasks and the board](Tasks-and-the-board)).

## In detail

- [Addressing agents from one Telegram chat](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/telegram-multi-agent.md)
- [Telegram group topics as a task inbox](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/telegram-topic-inbound.md)
- [Bridge locale: service texts follow your language](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/telegram-bridge-locale.md)
- [Editable run status and split of long answers](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/telegram-dm-status.md)
- [Decision cards delivered to the owner's Telegram](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/owner-telegram-cards.md)
- Telegram notification settings and jobs: [SETTINGS.md](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/SETTINGS.md), sections «TG-NOTIFY-SETTINGS» and «TG-NOTIFY jobs»
