---
settings-section: Track 5 — operations
---

## settings-en-replace

| `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` | IDLE-PICKUP | `30` | How often (sec) the board itself wakes an agent with assigned `todo`/`in_progress` tasks and no live run: the top ready task by priority gets an `idle_pickup` wake bound to the task (issueId in context, without 403 cross-issue). A wake also fires right after a finished run releases the task execution lock. A ready task = without open blockers (`issue_relations` type `blocks` with an open blocker, including a cancelled one), not a container (no open children) and not waiting on a scheduled monitor (`monitor_next_check_at` in the future — that wake belongs to the monitor tick, which fires the task exactly at the scheduled time; an elapsed monitor does NOT exclude the task). One run per pass; pause, maintenance mode, admission limits (C0), parallelism and agent daily ceilings are respected — checked by the wake admission path itself, not this pass | Values below 5 — 5. Non-numeric, `0`, negative or fractional — the default |

## settings-ru-replace

| `MYRMIDON_IDLE_PICKUP_INTERVAL_SEC` | IDLE-PICKUP | `30` | Как часто (сек) доска сама будит агента с назначенными задачами `todo`/`in_progress` без живого прогона: верхняя готовая задача по приоритету получает побудку `idle_pickup` с привязкой к задаче (issueId в контексте, без 403 cross-issue). Побудка также идёт сразу после освобождения замка исполнения задачи завершившимся прогоном. Готовая задача = без незакрытых блокеров (`issue_relations` type `blocks` с открытым блокером, включая отменённый), не контейнер (нет открытых дочерних) и не ждёт запланированного монитора (`monitor_next_check_at` в будущем — этой побудкой владеет тик монитора, который будит задачу ровно в назначенное время; наступивший монитор задачу НЕ исключает). Один прогон за проход; пауза, режим обслуживания, лимиты допуска (C0), параллельность и дневные потолки агента уважаются — проверяет их сам путь допуска побудок, не этот проход | Значения меньше 5 — 5. Нечисловое, `0`, отрицательное или дробное — по умолчанию |
