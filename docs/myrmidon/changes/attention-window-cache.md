---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Attention feed: bounded failed-run window and a per-company cache (ATTENTION-WINDOW-CACHE)

- `GET /api/companies/:id/attention` recomputed the whole feed on every
  request and read every unresolved failed run of the company. The query
  window grew with the age of the oldest unresolved failure, so on
  production-like volume the route answered in tens of seconds.
- The failed-run window is now bounded by a horizon: exhausted runs created
  older than `now − horizon` never enter the feed, and the follow-up run
  lookup is additionally constrained by `created_at > greatest(oldest failed
  run, now − horizon)`. The horizon is an instance setting
  (`instance_settings.general.attentionFailedRunHorizonDays`, default 7
  days). Card semantics for fresh failures are unchanged.
- The built feed snapshot is cached per company in an in-process TTL cache
  (`instance_settings.general.attentionFeedCacheTtlSeconds`, default 45
  seconds). The cache key is the company, the request options
  (`all`/`queue`/`userId`/`includeDismissed`) and the horizon. Writes
  (dismiss, decisions) are visible with up to the TTL delay; there is no
  invalidation event and no new table, and no redis.
- Unit tests cover the horizon (an old failure stays out, a fresh failure is
  in, the second query window is bounded) and the cache (a second `list()`
  inside the TTL serves the stored snapshot and runs no new feed queries;
  after expiry the feed is rebuilt). Existing attention suites pass; the
  read-after-write suites opt the cache out per service instance.

## changelog-ru

### Attention-фид: ограниченное окно сбойных прогонов и кэш фида по компании (ATTENTION-WINDOW-CACHE)

- `GET /api/companies/:id/attention` пересчитывал весь фид на каждый запрос
  и читал все нерешённые сбои компании. Окно запроса росло с возрастом
  старейшего нерешённого сбоя, поэтому на объёме, близком к бою, маршрут
  отвечал десятками секунд.
- Окно сбойных прогонов теперь ограничено горизонтом: исчерпанные прогоны
  старше `now − горизонт` не попадают в фид, а повторный поиск прогонов
  дополнительно ограничен `created_at > greatest(старейший сбой, now −
  горизонт)`. Горизонт — настройка инстанса
  (`instance_settings.general.attentionFailedRunHorizonDays`, умолчание 7
  дней). Семантика карточек свежих сбоев не меняется.
- Собранный срез фида кэшируется по компании in-process кэшем с TTL
  (`instance_settings.general.attentionFeedCacheTtlSeconds`, умолчание 45
  секунд). Ключ кэша — компания, опции запроса
  (`all`/`queue`/`userId`/`includeDismissed`) и горизонт. Записи (dismiss,
  решения) видны с задержкой до TTL; события инвалидации нет, новых таблиц
  нет, redis не используется.
- Unit-тесты покрывают горизонт (старый сбой не попадает, свежий попадает,
  окно второго запроса ограничено) и кэш (второй `list()` внутри TTL берёт
  сохранённый срез и не поднимает новых запросов сборки фида; после
  истечения фид пересобирается). Существующие attention-тесты зелёные;
  read-after-write тесты отключают кэш на своём экземпляре сервиса.

## divergence

| ATTENTION-WINDOW-CACHE | Окно сбойных прогонов attention-фида ограничено горизонтом из настроек инстанса (умолчание 7 дней), сборка фида кэшируется in-process по компании (умолчание 45 с, инвалидация только по TTL — записи видны с задержкой до TTL). Реализация: опция `createdAtAfter` в `server/src/services/attention-exhausted-runs.ts`, чтение `instance_settings.general` и кэш-снапшот в `server/src/services/attention.ts`, ключи задекларированы в `packages/shared/src/validators/instance.ts`. Без миграции и без redis | `server/src/services/attention.ts`, `server/src/services/attention-exhausted-runs.ts`, `packages/shared/src/validators/instance.ts`, `server/src/__tests__/attention-feed-window-cache.test.ts` | Attention-фид на боевом объёме отвечает в пределах секунд, окно запроса не растёт с возрастом старейшего нерешённого сбоя | `server/src/__tests__/attention-feed-window-cache.test.ts` | Никогда, наше поведение | — |

## settings-en

| `attentionFailedRunHorizonDays` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `7` | Horizon in days of the failed-run window of the attention feed: exhausted runs older than `now − horizon` stay out of the feed and the follow-up run lookup is bounded by `created_at > greatest(oldest failed run, now − horizon)` | From 1 to 365; missing or out of bounds — the default. No migration, no restart |
| `attentionFeedCacheTtlSeconds` (`instance_settings.general`) | ATTENTION-WINDOW-CACHE | `45` | Per-company in-process TTL of the built attention feed snapshot. Writes are visible with up to this delay | From 0 to 300; `0` — the cache is off. Missing or out of bounds — the default |

