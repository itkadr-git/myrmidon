---
settings-section: Track 2 — wake and run core
---

## changelog-en

### The empty-run streak emits a SKIPPED signal instead of blocking, and the threshold is a setting (OPE-12935)

The consecutive-empty-run escalation was a hard stop: after 5 empty runs the issue was
flipped to `blocked` with a STOP CONDITION comment and rewakes were suppressed. That made
a lifecycle threshold behave as a spend cap and silently parked tasks. Now:

- reaching the threshold writes one `run.autopause.empty_streak` run-log event (warn,
  payload: `reason=empty_run_streak`, streak, threshold, description, lastRunId) and a
  `skipped` wakeup receipt with the same reason (`payload.heartbeatSkip`) — the issue is
  NOT blocked, no STOP CONDITION comment is posted, rewakes are NOT suppressed;
- the threshold is configurable: instance general setting `emptyRunStreakThreshold`
  (integer 2–20, default 5), read through a 30 s process cache, so a saved value applies
  without a restart within that delay; a productive run still resets the streak to 0;
- the signal never acts as a budget cap: productive work is never skipped or escalated
  regardless of the streak.

## changelog-ru

### Серия пустых прогонов отдаёт SKIPPED-сигнал вместо блокировки, порог — настройка (OPE-12935)

Эскалация серии пустых прогонов была жёсткой остановкой: после 5 пустых прогонов задача
переводилась в `blocked` с комментарием STOP CONDITION, а пробуждения подавлялись. Так
жизненный порог работал как лимит расходов и молча парковал задачи. Теперь:

- достижение порога пишет одно событие run-лога `run.autopause.empty_streak` (warn,
  payload: `reason=empty_run_streak`, streak, threshold, description, lastRunId) и
  `skipped`-квитанцию побудки с той же причиной (`payload.heartbeatSkip`) — задача НЕ
  блокируется, комментарий STOP CONDITION не пишется, пробуждения НЕ подавляются;
- порог настраивается: общая настройка экземпляра `emptyRunStreakThreshold`
  (целое 2–20, по умолчанию 5), читается через процессный кэш 30 с, поэтому сохранённое
  значение действует без перезапуска с задержкой до этого кэша; продуктивный прогон по-прежнему
  сбрасывает серию в 0;
- сигнал никогда не работает как лимит расходов: продуктивная работа не пропускается
  и не эскалируется независимо от серии.

## settings-en

| `emptyRunStreakThreshold` (`instance_settings.general`) | OPE-12935 | `5` | Consecutive empty runs of one issue after which the board emits its SKIPPED signal: one `run.autopause.empty_streak` run-log event (warn) plus a `skipped` wakeup receipt with reason `empty_run_streak`. The signal is informational — it does not block the issue and does not suppress rewakes by itself; a productive run resets the streak to 0 | Integer 2–20; values outside the range or non-integer are rejected by the settings validator. Absent — the default 5. Edit via `GET`/`PATCH /api/myrmidon/settings/general`; read through a 30 s process cache, so a saved value applies without a restart within up to 30 s |

## settings-ru

| `emptyRunStreakThreshold` (`instance_settings.general`) | OPE-12935 | `5` | Сколько пустых прогонов задачи подряд нужно, чтобы доска отдала SKIPPED-сигнал: одно событие run-лога `run.autopause.empty_streak` (warn) плюс `skipped`-квитанция побудки с причиной `empty_run_streak`. Сигнал информационный — он не блокирует задачу и сам по себе не подавляет пробуждения; продуктивный прогон сбрасывает серию в 0 | Целое 2–20; значения вне диапазона или нецелые отклоняет валидатор настроек. Отсутствует — по умолчанию 5. Правится через `GET`/`PATCH /api/myrmidon/settings/general`; читается через процессный кэш 30 с, поэтому сохранённое значение действует без перезапуска с задержкой до 30 с |
