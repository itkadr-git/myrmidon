# Comments and interactions

## Where in code

- `server/src/routes/issues.ts:17117` and `:19148` implement comment listing and creation on issues; `:18772` and `:18793` handle single comment retrieval and soft deletion.
- `server/src/routes/issues.ts:17660` and `:17676` define listing and creation for issue thread interactions; resolution endpoints span `:17875` (accept), `:18215` (reject), `:18325` (respond), `:18410` (verdicts), `:18504` (withdraw), `:18611` (skip), and `:18669` (cancel).
- `server/src/services/issues.ts:12351` implements `addComment` with issue row serialization (`for("update")`), secret masking, and attribution checks.
- `server/src/services/issue-thread-interactions.ts:1967` creates `issueThreadInteractionService`; interaction policy evaluation lives at `:397`.
- `server/src/myrmidon/interaction-continuation-outbox.ts:388` provides `interactionContinuationOutboxService` with mutation intent logging at `:212` and policy checks at `:153`.
- `server/src/services/issue-comment-wakeup.ts:12` implements `shouldWakeAssigneeForIssueComment`.
- `server/src/services/issue-queued-comment-queue.ts:23` extracts queued comment IDs from wake payloads for runtime steering.
- `packages/db/src/schema/issue_comments.ts:15` and `packages/db/src/schema/issue_thread_interactions.ts:18` define the underlying PostgreSQL schemas.

## How it is intended

Comments and interactions provide human-to-agent and agent-to-agent communication on an issue. Comments offer unstructured dialogue, progress updates, and discussion, while preserving actor provenance, masking secrets, and waking the assignee when actionable input arrives. Interactions structure high-stakes conversational turns into typed protocol cards (`suggest_tasks`, `ask_user_questions`, `request_confirmation`) with explicit schemas, resolution permissions, and deterministic continuations. Resolving an interaction or submitting an actionable comment must reliably wake the targeted agent run without duplicate runs, dropped wakeups, or race conditions.

## How it is implemented

`issueService.addComment` serializes comment insertions by locking the parent issue row in a transaction, preventing race conditions or duplicate publications from retried runs. It validates author attribution, censors usernames and masks secrets in agent-written content, and evaluates `shouldWakeAssigneeForIssueComment` (skipping self-comments from active runs and suppressing prompt-budget notices) before enqueuing a wake through `heartbeat.wakeup`. Unread comment IDs are packaged in the wake payload via `issue-queued-comment-queue.ts`.

Interactions are managed by `issueThreadInteractionService` and stored in `issue_thread_interactions` with unique idempotency keys per issue. When a card is resolved (accepted, rejected, or answered), `interactionContinuationOutboxService` records a transactional intent row directly in `agent_wakeup_requests` during the resolution transaction. A post-commit hook attempts direct delivery, while a periodic background sweep (`sweepPending`) retries undelivered intents. This transactional outbox pattern guarantees that transient lock contention or process crashes after the commit cannot drop the continuation wakeup.

## Difference from the intended design

Rather than a single unified message bus, the system separates unstructured comments and structured interactions into distinct database tables and route trees. The direct continuation dispatch after card resolution historically suffered from dropped wakeups under load or process restarts; the transactional outbox was retrofitted over `agent_wakeup_requests` rather than introducing a separate messaging broker. Additionally, comment-driven wakes require complex heuristics (distinguishing user-authenticated agent runs from actual human comments to avoid unintentional issue reopenings).

## Related

- [[heartbeat-runner]]
- [[issue-store-checkout]]
- [[task-queue]]
- [[blocks-dependencies]]
- [[inbox-lite]]
