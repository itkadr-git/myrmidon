# CTO-CHAT: the `/plan` command in Telegram

> Russian version: [cto-chat-telegram-plan.ru.md](cto-chat-telegram-plan.ru.md)

## Overview
The `/plan` command lets the company owner turn free text in their Telegram direct message with the board bot into an epic proposal — the same planner and the same approval card the portal chat screen uses. Sending `/plan <what you need>` posts a pending `suggest_tasks` card on the conversation's task and answers with a short acknowledgement naming the proposal and pointing at the task.

## Behavior
- The command is available only to the company owner (the user whose company membership role is `owner`); anyone else receives a refusal and nothing is created.
- A successful run posts a pending `suggest_tasks` card on the conversation task — the card the board's ordinary acceptance path turns into an epic with child tasks.
- The reply names the proposed epic and links the task the card sits on.
- A planner failure (gateway unreachable, model output invalid, planner not configured) answers with one readable line; a stack trace never reaches the chat.
- The planner contour (`MYRMIDON_CTO_CHAT_BASE_URL`, `MYRMIDON_CTO_CHAT_KEY_SECRET`, `MYRMIDON_CTO_CHAT_MODEL`, …) is read on every call, so rotating the address, the key-secret name or the model takes effect on the next `/plan` without a restart. The command itself needs no separate switch: when CTO-CHAT is not configured, `/plan` answers "I cannot plan right now" — the same answer the portal chat screen gives.

## Usage
```
/plan build a weekly report page with numbers from the ledger
```

## Requirements
- The sender must hold the `owner` membership role in the company.
- CTO-CHAT must be configured on the server (`MYRMIDON_CTO_CHAT_BASE_URL` and `MYRMIDON_CTO_CHAT_KEY_SECRET` set — see `docs/myrmidon/SETTINGS.md`).
- The company must have the named key secret stored in its secrets.

## Security
- Ownership is checked before the planner is called; a non-owner never reaches the model.
- The API key is read from the company's secrets per call and never stored on the command path; error messages never carry model output, keys or stack traces.
- The card is created only on the conversation task the message already belongs to.
