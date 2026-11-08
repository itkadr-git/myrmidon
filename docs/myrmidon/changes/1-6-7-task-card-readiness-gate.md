---
settings-section: Track 5 — operations
---

## changelog-en

### TASK-CARD-READINESS-2: Task card readiness server gate

- Server-side readiness check for task cards (`assertTaskCardReady`) based on the slice-1 evaluation engine.
- Rejects incomplete cards with 422 `task_card_not_ready` in `enforce` mode; logs a warning during the 3-day grace period or when `MYRMIDON_TASK_CARD_GATE_MODE=warning`.

## changelog-ru

### TASK-CARD-READINESS-2: Серверный гейт полноты карточки задачи

- Серверная проверка полноты карточек задач (`assertTaskCardReady`) на базе чекера слайса 1.
- В режиме `enforce` отклоняет неполные карточки с кодом 422 `task_card_not_ready`; в течение 3-дневного льготного периода или при `MYRMIDON_TASK_CARD_GATE_MODE=warning` пишет предупреждение в лог без блокировки.

## settings-en

| `MYRMIDON_TASK_CARD_GATE_MODE` | 1.6.7-TASK-CARD-READINESS | automatic rollout | Override the task-card readiness gate mode; `warning` logs a warning and permits transition, `enforce` rejects incomplete cards with 422 | Unset uses the date-based rollout |
| `MYRMIDON_TASK_CARD_GATE_START_DATE` | 1.6.7-TASK-CARD-READINESS | `2026-11-07` | Override the rollout anchor date used to switch from warning-only to enforcement | Unset uses the built-in rollout date |

## settings-ru

| `MYRMIDON_TASK_CARD_GATE_MODE` | 1.6.7-TASK-CARD-READINESS | автоматический rollout | Переопределяет режим гейта полноты карточки задачи: `warning` разрешает переход с предупреждением, `enforce` отклоняет неполные карточки с 422 | Без значения используется rollout по дате |
| `MYRMIDON_TASK_CARD_GATE_START_DATE` | 1.6.7-TASK-CARD-READINESS | `2026-11-07` | Переопределяет дату перехода от предупреждений к обязательной проверке | Без значения используется встроенная дата rollout |
