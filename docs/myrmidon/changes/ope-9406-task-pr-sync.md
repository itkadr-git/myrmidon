---
settings-section: Track 5 — эксплуатация
---

## changelog-en

### Task/PR status synchronization (OPE-9406)

- Run task/PR synchronization on a dedicated scheduler-leader timer rather than the heartbeat tick.
- Reconcile PR work products for non-terminal tasks and perform a periodic closed-task reconciliation; stop timers during graceful shutdown.

## changelog-ru

### Синхронизация статусов задач и PR (OPE-9406)

- Запускать синхронизацию задач и PR отдельным таймером лидера scheduler, независимо от heartbeat.
- Сверять PR-продукты нетерминальных задач и периодически закрытые задачи; останавливать таймеры при graceful shutdown.

## settings-en

| `MYRMIDON_TASK_PR_SYNC_POLL_SEC` | OPE-9406 | `60` | Dedicated task/PR synchronization timer interval in seconds; minimum 15, runs only on the scheduler leader | Invalid, fractional, or below 15 — uses the default |

## settings-ru

| `MYRMIDON_TASK_PR_SYNC_POLL_SEC` | OPE-9406 | `60` | Интервал отдельного таймера синхронизации задач и PR в секундах; минимум 15, работает только на лидере scheduler | Неверное, дробное значение или меньше 15 — используется умолчание |
