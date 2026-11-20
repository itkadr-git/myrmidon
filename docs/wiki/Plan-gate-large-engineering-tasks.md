# Plan gate for large engineering tasks

> Русская версия: [Plan-gate-large-engineering-tasks.ru](Plan-gate-large-engineering-tasks.ru)

Issues assigned to an engineering agent and labeled `size:M` or `size:L` enter `planning` mode when they have no `plan` document. The agent must publish the plan and request confirmation bound to the plan revision before implementation begins.

For an agent-resolved confirmation, the approval recipient is the first invokable `lead` or `architect` agent in the executor's manager chain, then any such agent of the company, then the agent `adm`. The executor never approves its own plan. Approval returns the issue to standard execution. Small tasks and tasks with an existing plan are unchanged.

A `human_only` confirmation instead preserves the explicitly addressed user; omit `addresseeUserId` to use the owner fallback. Agents cannot accept or reject it. Save the `plan` document first and use its exact current `latestRevisionId` in the target and idempotency key. The synthetic payload below is an example only; do not send it as written.

`POST /api/issues/{issueId}/interactions`

```json
{
  "kind": "request_confirmation",
  "resolverPolicy": "human_only",
  "addresseeUserId": "<user-id>",
  "idempotencyKey": "confirmation:<issue-id>:plan:<revision-id>",
  "payload": {
    "version": 1,
    "prompt": "Approve the plan?",
    "target": { "type": "issue_document", "key": "plan", "revisionId": "<revision-id>" }
  }
}
```

See the [human-only plan confirmation guide](../myrmidon/guides/human-only-plan-confirmation.md).
