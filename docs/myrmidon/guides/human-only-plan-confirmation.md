# Human-only plan confirmation

Save the issue's `plan` document, read it back, and use its exact current `latestRevisionId` when requesting confirmation. A stale revision is rejected. With `resolverPolicy: "human_only"`, an explicit `addresseeUserId` is preserved instead of being replaced by the engineering approver. Omit it to use the owner fallback. Agents cannot accept or reject this confirmation.

Example only; do not send these synthetic identifiers. `POST /api/issues/{issueId}/interactions`:

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

See also [plan gate for engineering tasks](../../wiki/Plan-gate-large-engineering-tasks.md) and the [Russian guide](human-only-plan-confirmation.ru.md).
