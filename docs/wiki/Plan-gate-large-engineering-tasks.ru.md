# Планирование крупных инженерных задач

> English version: [Plan-gate-large-engineering-tasks](Plan-gate-large-engineering-tasks)

Задачи, назначенные инженерному агенту и помеченные `size:M` или `size:L`, переходят в режим `planning`, если у них нет документа `plan`. Агент должен опубликовать план и запросить подтверждение, привязанное к ревизии плана, до начала реализации.

Для подтверждения агентом получатель — первый доступный агент с ролью `lead` или `architect` в цепочке руководителей исполнителя, затем любой такой агент компании, затем агент `adm`. Исполнитель не утверждает собственный план. После подтверждения задача возвращается к стандартному выполнению. Маленькие задачи и задачи с существующим планом не меняются.

Подтверждение `human_only` сохраняет явно указанного пользователя; если опустить `addresseeUserId`, выбирается владелец через fallback. Агент не может принять или отклонить такое подтверждение. Сначала сохраните документ `plan`, затем укажите его точный текущий `latestRevisionId` в target и ключе идемпотентности. Ниже синтетический пример, не отправляйте его как есть.

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

Подробнее: [подтверждение плана человеком](../myrmidon/guides/human-only-plan-confirmation.ru.md).
