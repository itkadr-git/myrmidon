# Соответствие маршрутов DELETE матрице автономности

> English version: [Delete-route-mapping](Delete-route-mapping)


Таблица определяет сопоставление HTTP-маршрутов `DELETE` и классов действий матрицы автономности.

| Маршрут | Метод | Класс действия | Защита | Примечание |
|---------|-------|----------------|--------|------------|
| `/api/issues/:id` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Удаляет задачу целиком |
| `/api/issues/:id/comments/:commentId` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Удаляет конкретный комментарий из задачи |
| `/api/attachments/:attachmentId` | DELETE | `delete` | `assertAgentIssueMutationAllowed` + `assertDeliverableMutationAllowedByRunContext` | Удаляет вложение из задачи |
| `/api/issues/:id/watchdog` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Удаляет таймер наблюдения задачи |
| `/api/work-products/:id` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Удаляет рабочий продукт (артефакт) |
| `/api/issues/:id/approvals/:approvalId` | DELETE | `delete` | `assertAgentIssueMutationAllowed` | Удаляет согласование из задачи |
| `/api/issues/:id/documents/:key` | DELETE | Н/Д | `req.actor.type !== "board"` | Удаляет документ задачи — только для доски |
| `/api/agents/:id` | DELETE | Н/Д | `assertBoard` | Удаляет агента — только для доски |
| `/api/agents/:id/keys/:keyId` | DELETE | Н/Д | `assertBoard` | Удаляет ключ агента — только для доски |
| `/api/agents/:id/instructions-bundle/file` | DELETE | Н/Д | `assertCanManageInstructionsPath` + `assertExternalInstructionsAdmin` | Удаляет файл инструкций — требует специальных прав |

Шесть доступных агентам маршрутов проверяют класс действия `delete` через `dbAutonomyGate(db).assertAllowed(req, "delete")`. Остальные маршруты ограничены только доской или администраторами и не регулируются матрицей автономности агентов.
