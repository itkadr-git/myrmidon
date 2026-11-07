---
settings-section: Track 5 — operations
---

## changelog-en

### BOARD-JANITOR: daily board hygiene routine and report (1.6.7)

- Automated daily board maintenance sweep running at 08:00 Irkutsk (00:00 UTC) and on-demand via `POST /api/myrmidon/board-janitor/run`.
- Automatically closes tasks with merged PRs.
- Safely lifts false blocks when no blocker or child task is open and no active question is pending.
- Automatically routes unassigned release tasks to role-based queue (DEVFLOW-9678) via notifySwarmIssueEvent.
- Flags untouched tasks (>21 days) with label "залежалась".
- Daily report written as document `janitor-YYYY-MM-DD` on service ticket.

## changelog-ru

### BOARD-JANITOR: ежедневная уборка доски и отчёт документом (1.6.7)

- Ежедневная уборка доски в 08:00 по Иркутску (00:00 UTC) и по вызову `POST /api/myrmidon/board-janitor/run`.
- Закрытие задач с влитыми PR в done.
- Безопасное снятие ложных блокировок (нет открытого блокера, дочерних и вопросов).
- Постановка неназначенных задач выпусков в очередь по ролям (DEVFLOW-9678) с уведомлением swarm matcher.
- Маркировка залежавшихся задач (>21 дня) меткой «залежалась».
- Отчёт документом `janitor-YYYY-MM-DD` на служебном тикете.

## settings-en

| `MYRMIDON_BOARD_JANITOR_ENABLED` | 1.6.7-JANITOR | `1` (on) | Master switch for daily board janitor routine | `0` to disable |
| `MYRMIDON_BOARD_JANITOR_RUN_HOUR_IRKUTSK` | 1.6.7-JANITOR | `8` | Hour of day in Irkutsk time (UTC+8) when daily sweep triggers | Default 8 (00:00 UTC) |
| `MYRMIDON_BOARD_JANITOR_SERVICE_AGENT_ID` | 1.6.7-JANITOR | `b018f9bf-3f76-48d5-9530-aa9b0bf917f9` | Agent ID under whose name janitor actions and comments are authored | UUID |
| `MYRMIDON_BOARD_JANITOR_SERVICE_TICKET_ID` | 1.6.7-JANITOR | `a8529883-ab02-4998-a5ab-d70cd81560f8` | Service ticket where the daily report document is written | Issue UUID |

## settings-ru

| `MYRMIDON_BOARD_JANITOR_ENABLED` | 1.6.7-JANITOR | `1` (вкл) | Главный выключатель ежедневной уборки доски | `0` для отключения |
| `MYRMIDON_BOARD_JANITOR_RUN_HOUR_IRKUTSK` | 1.6.7-JANITOR | `8` | Час суток по Иркутску (UTC+8) для запуска уборки | По умолчанию 8 (00:00 UTC) |
| `MYRMIDON_BOARD_JANITOR_SERVICE_AGENT_ID` | 1.6.7-JANITOR | `b018f9bf-3f76-48d5-9530-aa9b0bf917f9` | ID служебного агента для действий и комментариев уборщика | UUID |
| `MYRMIDON_BOARD_JANITOR_SERVICE_TICKET_ID` | 1.6.7-JANITOR | `a8529883-ab02-4998-a5ab-d70cd81560f8` | Служебный тикет для отчётов уборщика доски | Issue UUID |
