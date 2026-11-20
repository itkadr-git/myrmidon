# Подтверждение плана человеком

Сохраните документ задачи `plan`, прочитайте его обратно и укажите точный текущий `latestRevisionId` при запросе подтверждения. Устаревшая ревизия отклоняется. При `resolverPolicy: "human_only"` явно указанный `addresseeUserId` сохраняется и не заменяется инженерным согласующим. Если его опустить, используется fallback на владельца. Агент не может принять или отклонить это подтверждение.

Только пример: не отправляйте синтетические идентификаторы. `POST /api/issues/{issueId}/interactions`:

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

См. также [планирование инженерных задач](../../wiki/Plan-gate-large-engineering-tasks.ru.md) и [руководство на английском](human-only-plan-confirmation.md).
