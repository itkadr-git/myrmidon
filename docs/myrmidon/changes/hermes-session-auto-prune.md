## changelog-en

### Bot profile now spells out Hermes' state.db maintenance (1.6.6 BOT-DISK)

- The compiled `config.yaml` of every bot now carries Hermes' own `sessions.*` maintenance keys next to
  `retention_days`: `auto_prune: true`, `vacuum_after_prune: true`, `min_interval_hours: 24` and
  `min_vacuum_interval_days: 7` (Hermes' defaults are `true`, `true`, 24 and 30). The values are fixed
  constants (`instanceDefaults` has no matching setting); the keys are written even when no retention is
  configured, so a change of the vendor defaults can no longer switch the maintenance off silently.
- The profile change alters `restartHash`, so every bot is recreated once by the normal rollout.
- This does not by itself shrink `state.db`: Hermes runs VACUUM only in a pass whose own prune deleted at
  least one session, and the container runtime (`MYRMIDON_BOTD_SESSION_RETENTION_DAYS`, 30 days) deletes
  older sessions first. Reclaiming the free pages needs a separate change.

## changelog-ru

### Профиль бота явно задаёт обслуживание state.db Hermes (1.6.6 BOT-DISK)

- В собранном `config.yaml` каждого бота рядом с `retention_days` теперь стоят штатные ключи
  обслуживания Hermes `sessions.*`: `auto_prune: true`, `vacuum_after_prune: true`,
  `min_interval_hours: 24` и `min_vacuum_interval_days: 7` (умолчания Hermes: `true`, `true`, 24 и 30).
  Значения — константы (в `instanceDefaults` подходящей настройки нет); ключи пишутся и без заданного
  срока хранения, поэтому смена умолчаний вендора больше не выключит обслуживание молча.
- Изменение профиля меняет `restartHash`, поэтому каждый бот один раз пересоздаётся обычным выкатом.
- Само по себе это `state.db` не уменьшает: Hermes делает VACUUM только в проходе, где его собственная
  очистка удалила хотя бы одну сессию, а runtime контейнера (`MYRMIDON_BOTD_SESSION_RETENTION_DAYS`,
  30 дней) удаляет старые сессии раньше. Возврат свободных страниц требует отдельного изменения.
