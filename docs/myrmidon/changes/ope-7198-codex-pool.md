---
settings-section: Track 6 — security and models
---

## changelog-en

### ChatGPT/Codex model provider pool accounts registry, limit windows, and operator attention signals (OPE-7198)

- Registered model provider connector extension point with dynamic provider type availability (`registerModelProviderConnector`, `isModelProviderTypeAvailable`).
- Multi-provider account isolation and limit window tracking (5-hour and 7-day windows) with automated reset timestamp computation.
- Background sweeper (`MYRMIDON_POOL_SWEEP_INTERVAL_SEC`) and attention feed snapshot integration for automatic pool account synchronization and operator attention alerts.
- Plugin lifecycle bridge synchronizing dynamic connector availability with plugin status changes.

## changelog-ru

### Реестр пула аккаунтов ChatGPT/Codex, окна лимитов и сигналы внимания оператора (OPE-7198)

- Точка расширения коннекторов моделей с динамической проверкой доступности типов (`registerModelProviderConnector`, `isModelProviderTypeAvailable`).
- Мульти-провайдерная изоляция аккаунтов и отслеживание окон лимитов (5-часовое и 7-дневное) с расчетом времени эффективного сброса.
- Фоновый опрос (`MYRMIDON_POOL_SWEEP_INTERVAL_SEC`) и интеграция со снэпшотом ленты внимания для автосинхронизации аккаунтов и карточек внимания оператора.
- Мост жизненного цикла плагинов для динамической регистрации коннекторов при изменении статуса плагина.

## settings-en

| `MYRMIDON_POOL_SWEEP_INTERVAL_SEC` | OPE-7198 | `300` (5 min) | Interval in seconds for the background periodic sweep of model provider pool accounts (synchronizes account windows, channel states, and operator attention signals without requiring a settings page open) | From 30 to 86400; non-numeric or out-of-range uses the default (300) |

## settings-ru-append

<!-- section: Трек 6 — безопасность и модели -->

| `MYRMIDON_POOL_SWEEP_INTERVAL_SEC` | OPE-7198 | `300` (5 мин) | Интервал в секундах для фонового периодического опроса пулов провайдеров моделей (актуализирует окна лимитов, каналы и сигналы внимания оператора без необходимости открытия страницы настроек) | От 30 до 86400; нечисловое или вне диапазона — по умолчанию (300) |
