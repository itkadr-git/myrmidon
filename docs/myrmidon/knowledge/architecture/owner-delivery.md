# Owner delivery

## Where in code

- `packages/shared/src/myrmidon-owner-delivery.ts:31` defines `OWNER_DELIVERY_MODES` (`via_bot`, `owner_decisions_only`, `all`) and `:35` sets default mode `via_bot`.
- `packages/shared/src/myrmidon-owner-delivery.ts:54` implements audience check `isOwnerDecisionAudience` and `:82` defines `ownerDeliveryAllowsCard`.
- `server/src/myrmidon/owner-delivery/routes.ts:57` mounts `ownerDeliveryRoutes`, exposing settings endpoints and agent owner-message routes (`:64`, `:69`, `:78`, `:95`).
- `server/src/myrmidon/owner-delivery/owner-message.ts:84` schedules owner-explain wakes (`scheduleOwnerExplainWake`), `:177` sends messages to owner DM (`sendOwnerMessage`), and `:360` enforces reply authorization (`authorizeOwnerReplyResolution`).
- `server/src/myrmidon/owner-delivery/owner-autoclose.ts:194` implements `autoCloseOwnerDecisionOnOwnerComment` to resolve single owner questions without an agent run.
- `server/src/myrmidon/owner-delivery/classify.ts:39` implements `classifyOwnerDeliveryPublication` for journal tagging.
- `server/src/myrmidon/owner-delivery/publications-journal.ts:51` provides `ownerDeliveryJournalRoutes` for auditing delivered cards.

## How it is intended

Owner delivery routes reports, pending interaction cards, and explanatory messages to the task owner's direct channel (primarily Telegram DM) while preventing spam from internal operational agent cards. When cards have no task-bound chat thread, only decisions genuinely intended for the human owner (`human_only` policy or addressed to the task owner) should be delivered under filtered modes. Under the default `via_bot` mode, interactive UI button cards are suppressed entirely from owner DMs; instead, the agent is woken to explain the pending decision in plain text, and the owner's free-text reply closes the interaction. Direct text answers to unambiguous questions in task chat should auto-resolve without requiring a redundant agent execution turn.

## How it is implemented

The subsystem combines shared filter contracts with server routes and dialogue guards. `instanceSettings` stores the active delivery mode (`via_bot`, `owner_decisions_only`, or `all`). When an interaction is raised, `scheduleOwnerExplainWake` enqueues an automation wake for the author agent if `via_bot` is active and an owner DM conversation exists. The agent invokes `POST /api/myrmidon/owner-message` to publish an explanation comment linked to the interaction ID via metadata labels. When the owner answers in Telegram, `authorizeOwnerReplyResolution` verifies the reply before executing an action (`accept`, `reject`, `respond`) on behalf of the owner through standard issue-thread interaction routes. For plain text comments inside task chats, `autoCloseOwnerDecisionOnOwnerComment` detects matching single open questions and closes them directly through `issueThreadInteractionService` and `interactionContinuationOutboxService`. All publications to owner DMs are classified and journaled for operator inspection.

## Difference from the intended design

Instead of a single delivery pipeline, owner delivery is split between card filtering in chat channels, agent explanation workflows (`via_bot`), and auto-close heuristics for incoming chat comments. Closing an owner decision in `via_bot` mode requires the agent to run, call `owner-message`, and subsequently call `owner-message/resolve`, whereas unmanaged cards use direct comment auto-close. Operators must therefore inspect both `owner_delivery` journal records and heartbeat execution logs to determine why a card was filtered, explained via bot, or auto-closed.

## Related

- [[inbox-lite]]
- [[heartbeat-runner]]
- [[task-queue]]
