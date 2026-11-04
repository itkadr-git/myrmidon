# Agent chat bridge

## Where in code

- `server/src/myrmidon/agent-chat-bridge/bridge.ts:141` implements `decideTelegramDmBinding`, `:256` ensures `chatConversations` bindings (`ensureTelegramDmConversation`), and `:439` handles bridged commands (`handleTelegramDmCommand`).
- `server/src/myrmidon/agent-chat-bridge/addressing.ts:128` implements `resolveTelegramAddressee` and `:369` implements `resolveBridgeAddressee` for `@<alias>` parsing.
- `server/src/myrmidon/agent-chat-bridge/links.ts:61` rewrites board links to absolute URLs (`absolutizeBoardLinks`).
- `server/src/myrmidon/telegram-notify/index.ts:16` exports notify job entries and `:494` in `server/src/myrmidon/telegram-notify/jobs.ts` starts background cron jobs (`startTelegramNotifyJobs`).
- `server/src/myrmidon/telegram-notify/jobs.ts:219` runs periodic attention digests (`runDigestForCompany`) and `:342` dispatches escalations (`runEscalationsForCompany`).
- `server/src/myrmidon/telegram-notify/errors.ts:85` filters board errors (`filterErrorChannelCard`) and `:312` sweeps error notifications (`sweepErrorChannel`).
- `server/src/myrmidon/telegram-notify/service.ts:56` merges Telegram notify settings and maintains changelogs.

## How it is intended

The agent chat bridge connects external chat channels (primarily Telegram) to Myrmidon's internal agent runtime. Rather than treating every incoming Telegram message as an isolated ad-hoc task, direct messages map to persistent, standing `chatConversations` bound to the user and channel endpoint. Users can address specific agents using `@<alias>` handles, switch active models or reasoning modes with slash commands, and receive formatted activity feeds, digests, and error notifications. Notifications (digests, escalations, error sweeps) should respect rate limits, severity filters, and delivery targets without saturating the user channel.

## How it is implemented

`bridge.ts` integrates with `chat-channels` provider events. Upon receiving an inbound message, it resolves the Telegram user identity, matches or creates a standing `chatConversations` record, and checks whether the message is a command (`/model`, `/think`, `/reset`, `/agents`), an addressed agent mention, or a continuation. Alias resolution in `addressing.ts` maps `@<alias>` tokens to specific agent cards, prepending reply context when necessary. Links are absolutized via `links.ts`. The sibling `telegram-notify` subsystem operates scheduled background loops via `startTelegramNotifyJobs` to collect attention items, format periodic company digests (`runDigestForCompany`), escalate stalled issues (`runEscalationsForCompany`), and publish rate-limited system errors (`sweepErrorChannel`) into configured topics or channels.

## Difference from the intended design

The bridge bridges two distinct models: the conversational direct messaging flow (`agent-chat-bridge`) and the periodic notification/cron publisher (`telegram-notify`). Furthermore, direct messages are represented internally as special issue threads with standing conversation markers, meaning agent replies still execute via standard issue runs and comments. Message delivery, alias routing, and error channels rely on multiple loosely coupled background sweeps and provider effect payloads rather than a unified bidirectional chat gateway.

## Related

- [[inbox-lite]]
- [[heartbeat-runner]]
- [[owner-delivery]]
