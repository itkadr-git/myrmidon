---
title: Agent chat
summary: Persistent conversations between agents and chat channels
---

Agent Chat bridges an external channel to a persistent conversation owned by an agent. A direct message is not converted into an ad-hoc task: the bridge resolves the channel and participant, finds or creates the standing conversation, and appends an inbound message to it.

## Message path

1. A channel adapter authenticates and normalizes an inbound event.
2. Addressing resolves the company, agent, conversation, and participant identity.
3. The bridge stores the message with an idempotency key before scheduling work.
4. The agent heartbeat reads the conversation context and produces a reply through the outbound channel adapter.
5. Delivery status and failures are recorded against the conversation message.

The bridge separates channel identity from Myrmidon identity. Telegram or another channel may provide a sender id, but authorization is decided by the resolved company and participant record. A reply is scoped to the conversation that generated it, preventing cross-company or cross-thread delivery.

## Reliability rules

Inbound retries are safe because event ids are deduplicated. A delivery failure remains visible for retry; it does not create a second conversation. Ordering is preserved per conversation where the channel supports ordering, while independent conversations may progress concurrently.

Chat is an interaction surface, not a replacement for task governance. Agents still use the control-plane APIs for assignments, approvals, comments, and durable work.

## Source map

- `server/src/myrmidon/agent-chat-bridge/` — addressing, bridge, commands, locales, and channel integration.
- `server/src/routes/chat-channels.ts` — HTTP entry points into the bridge.
- `server/src/services/agent-chat.ts` — conversation and message persistence.
