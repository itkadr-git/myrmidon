---
divergence-section: 1.7 — METRICS: собственные метрики доски в формате Prometheus (часть A)
---

## changelog-en

### Metrics self-check probe (1.6.6 METRICS annex)

- `GET /api/myrmidon/monitoring/selfcheck` — the link self-check of the
  metrics module: one scrape of every family, answered as the aggregate
  `{ok, families_ok, families_failed, scrape_ms, checked_at}` with no
  secret and no metric value. The probe rides the same origin-root router
  and the same single scraper bearer token as `GET /metrics` — no board
  rights, no second credential. 200 on a green scrape, 503 when a family
  read failed (the names it lists are exactly what `myrmidon_scrape_errors`
  exposes for the alerting half to open a task for the owning role), 500
  with the shape when the probe itself crashes.
- A failing family now reports by name: the collector returns the failed
  family list alongside the snapshot; `myrmidon_scrape_errors` keeps the
  counter role.

## changelog-ru

### Пробник самопроверки метрик (1.6.6, аннекс METRICS)

- `GET /api/myrmidon/monitoring/selfcheck` — самопроверка звена модуля
  метрик: один сбор всех семейств, ответ — агрегат
  `{ok, families_ok, families_failed, scrape_ms, checked_at}`, без
  секретов и значений метрик. Пробник едет на том же origin-роутере и
  под тем же единственным bearer-токеном скрейпера, что и `GET /metrics`,
  — без board-прав и без второй креды. 200 на зелёном сборе, 503 при
  отказе семейства (список имён совпадает с тем, что показывает
  `myrmidon_scrape_errors` — по нему тревожная половина ставит задачу
  роли-владельцу), 500 с формой при крахе самого пробника.
- Отказ семейства теперь называется по имени: коллектор возвращает список
  неудавшихся семейств вместе со снимком; счётчик `myrmidon_scrape_errors`
  остаётся на месте.

## divergence-replace

<!-- section: 1.7 — METRICS: собственные метрики доски в формате Prometheus (часть A) -->
| 1.7-METRICS | Эндпоинт `GET /metrics` на origin корня (вне `/api`, по образцу монтирования swarm-claim) отдаёт метрики доски в формате Prometheus text exposition 0.0.4, Content-Type `text/plain; version=0.0.4; charset=utf-8`. Семейства считаются on-the-fly из существующих таблиц и реестров — БЕЗ нового хранилища и миграций: прогоны (активные running/claimed, в очереди queued/retrying/scheduled_retry, failed за всё время и за окно — `heartbeat_runs`), очереди задач по ролям (issues × статус × роль assignee через join `agents.role`), аренды SWARM (живые — не released и не истёкшие, и всего строк — `issue_claims`), ошибки (failed runs за окно + живые сигналы attention-реестров tracing-health, stale-block и swarm-claim), расход (сумма `litellm_cost_events.cost_cents` за окно), задержки API (p50/p95 по `finishedAt − startedAt` прогона за окно latency, НЕ перехватчик запросов). Доступ — один bearer-токен: имя ключа в настройках (`MYRMIDON_METRICS_TOKEN_SECRET` — company secret по имени, первый резолвящийся; иначе env `MYRMIDON_METRICS_TOKEN`); без токена или с неверным — 401, эндпоинт никогда не «открывается». Значение токена не логируется и не возвращается. Окна — `MYRMIDON_METRICS_ERROR_WINDOW_SEC` (умолчание 3600) и `MYRMIDON_METRICS_LATENCY_WINDOW_SEC` (умолчание 21600), per-scrape override `?window=`/`?latency_window=`. Отказ одного семейства не роняет скрейп — `myrmidon_scrape_errors` Самопроверка звена (1.6.6): GET /api/myrmidon/monitoring/selfcheck на том же роутере (тот же bearer-токен, без board-прав) один раз собирает все семейства и отдаёт {ok, families_ok, families_failed, scrape_ms, checked_at} — только агрегат, без секретов и значений метрик; 200 зелёный прогон, 503 отказ семейства, 500 с формой при крахе пробника. | Наши файлы `server/src/myrmidon/monitoring/metrics/{metrics,routes,swarm-signals,index}.ts` + тесты `*.myrmidon.test.ts`; в вендоре только две строки с маркером `myrmidon(1.7-METRICS)` в `server/src/app.ts` (один импорт, один `app.use` на origin корне); свои строки в `docs/myrmidon/SETTINGS.md` и этот раздел | Эпик 1.7 MONITORING (часть A): доска скрейпится существующим стеком (VictoriaMetrics на хосте оператора), оператору нужны прогоны/очереди/аренды/ошибки/расход/задержки без ручного снятия дампов | `exposition.myrmidon.test.ts` (все семейства, по одному HELP/TYPE, квантили, экранирование лейблов, формат значений, процентиля), `routes.myrmidon.test.ts` (401 без токена/неверного/non-bearer, 200 с правильным, content-type 0.0.4, приоритет company secret над env, тайминг-безопасное сравнение, фолбэк при ошибке секрета), `collector.db.myrmidon.test.ts` (embedded-PG: счётчики прогонов, окно failed, p50/p95, роли×статусы, claim live/total, окно расхода, сигналы реестров, отказ семейства = scrape_errors без крэша), `guard.myrmidon.test.ts` (красный без модуля: импорт и монтирование за маркером 1.7-METRICS в app.ts, строки в SETTINGS/DIVERGENCE), `selfcheck.myrmidon.test.ts` (чистый фейк: семьи в families_failed при битой БД без крэша, тело ответа без секретов, форма collectMetricsParts) | Никогда, наше поведение. Снять: удалить каталог `server/src/myrmidon/monitoring/metrics/`, две строки с маркером `myrmidon(1.7-METRICS)` в app.ts и разделы в SETTINGS/DIVERGENCE | (этот PR) |
