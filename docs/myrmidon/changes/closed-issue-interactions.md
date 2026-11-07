## changelog-en

### Pending interactions expire when the issue closes (CLOSED-ISSUE-INTERACTIONS, #2235)

- When an issue transitions to a terminal status (`done` or `cancelled`) — through the HTTP routes or any direct service-level status update — every still-pending issue-thread interaction (`request_confirmation`, `ask_user_questions`, `suggest_tasks`, `request_item_verdicts`, …) moves `pending` → `expired` with result outcome `issue_closed` and `expirationReason: "issue_closed"`. `connection_intent` cards keep outcome `expired` and record the same `expirationReason`. Linked tool actions and secret proposals are revoked or expired in the same transaction; `resolvedAt` is stamped.
- The transition is idempotent: repeated terminal transitions and concurrent resolutions do not double-write, and a later resolve attempt on the expired card returns `409 interaction_issue_closed` instead of acting on a closed issue.
- Migration `0459_expire_pending_interactions_on_closed_issues` performed the one-time catch-up: pre-existing pending rows on issues already in a terminal status were expired in the same shape.
- Docs: the lifecycle is specified in `doc/execution-semantics.md` (§10 Issue-thread interaction resolution) and its Russian version, the API surface in `docs/api/issues.md`, and the agent guidance in `docs/guides/agent-developer/comments-and-communication.md`.

## changelog-ru

### Ожидающие карточки истекают при закрытии задачи (CLOSED-ISSUE-INTERACTIONS, #2235)

- При переводе задачи в терминальный статус (`done` или `cancelled`) — через HTTP-маршруты или любой прямой сервисный переход статуса — каждая ещё ожидающая карточка взаимодействий (`request_confirmation`, `ask_user_questions`, `suggest_tasks`, `request_item_verdicts`, …) переходит `pending` → `expired` с исходом `issue_closed` и `expirationReason: "issue_closed"`. Карточки `connection_intent` сохраняют исход `expired` и записывают тот же `expirationReason`. Связанные действия инструментов и предложения секретов отзываются или истекают в той же транзакции; проставляется `resolvedAt`.
- Переход идемпотентен: повторные терминальные переходы и конкурентные разрешения не пишут дважды, а попытка разрешить истёкшую карточку позже возвращает `409 interaction_issue_closed` вместо действия по закрытой задаче.
- Миграция `0459_expire_pending_interactions_on_closed_issues` выполнила разовый догон: существовавшие ожидающие строки по задачам, уже находившимся в терминальном статусе, истекли в той же форме.
- Доки: жизненный цикл описан в `doc/execution-semantics.md` (§10 Issue-thread interaction resolution) и его русской версии, API — в `docs/api/issues.md`, руководство агента — в `docs/guides/agent-developer/comments-and-communication.md`.
