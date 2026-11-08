---
title: Agent chat
summary: Agent addressing, conversation binding, and chat-channel bridging
---

> Русская версия: [agent-chat.ru.md](agent-chat.ru.md)

Agent Chat connects channel messages to agent conversations and task-thread bindings. The bridge resolves Telegram addressees from company agent names, titles, and aliases; identity helpers distinguish web conversations from Telegram conversations for the same board user. A Telegram DM can bind to a standing conversation issue, and commands operate against that binding.

## Message path

The channel route receives and normalizes webhook updates. Addressing determines a mentioned agent; binding logic checks whether the thread belongs to the relevant agent and user, then creates or reuses a conversation and its native-thread binding. The bridge handles eligible commands and supplies the conversation context for subsequent work. Cross-channel helpers can quote bounded recent messages from the same person's sibling conversation as context; the quote is explicitly treated as data, not as instructions.

## Boundaries

The bridge code provides addressing, identity, binding, command handling, cross-channel context, and channel integration. These modules do not establish a general event-id deduplication guarantee or ordered delivery across messages, so this page makes no such reliability claim. Task assignment and approvals remain governed by the control-plane APIs.

## Source map

- `server/src/myrmidon/agent-chat-bridge/` — addressing, bridge, commands, locales, and channel integration.
- `server/src/routes/chat-channels.ts` — webhook and channel HTTP entry points.
- `server/src/services/chat-channels.ts` and `server/src/services/chat-channel-binding.ts` — channel handling and bindings.
- `server/src/services/agent-conversations.ts` — conversation lifecycle and replay support.
- `server/src/myrmidon/agent-chat-bridge/{addressing,bridge,identity,cross-channel}.ts` and `commands/` — address resolution, binding, identity, context, and commands.
