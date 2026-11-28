# Реестр фоновых циклов (OPE-12618)

Источник: эпик OPE-12158 — «фоновые циклы по событию вместо опроса БД —
у нас так сделаны только чаты (D3)». Этот документ — вход для нарезки
перевода конкретных циклов на события; ни один цикл в этой задаче не
переведён.

Ратчет: `server/src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts`
считает каждый `setInterval(` / `laneInterval(` / `backgroundInterval(` под
`server/src` (без `*.test.ts` и `__tests__`) и сверяет счётчики с базовой
картой внутри теста. Новый таймер без записи в карте даёт красный тест с
подсказкой, куда дописать строку.

## Восемь вызовов `laneInterval`

| # | Цикл | Lane | Период по умолчанию | Что читает из БД за тик | Есть ли триггер по событию сегодня? | Какое событие подошло бы (live event / канал process-bus) | Риск перевода |
|---|------|------|---------------------|-------------------------|--------------------------------------|-----------------------------------------------------------|---------------|
| 1 | `execution_control` | `execution_control` | 15 с (`EXECUTION_RECONCILIATION_INTERVAL_MS`) | `heartbeat_runs` (брошенные control-строки), кандидаты на замену run, очередь доставки статусов, истёкшие `local_ai_logins`, настройки stall, строки pause-guard | Нет | live event `heartbeat.run.status`; канал process-bus `run_control`; `run_queued` для финализации | Средний — гейт leader-lease должен остаться; несколько под-свипов с разной формой чтения БД |
| 2 | `heartbeat_tick` | `heartbeat_tick` | 30 с (`heartbeatSchedulerIntervalMs`, env `HEARTBEAT_SCHEDULER_INTERVAL_MS`, минимум 10 с) | Истёкшие decision-строки, очередь retention, таблица runtime-status, строки timer due, предупреждения provider-usage, внешние объекты, подтверждения PR-merge, опросы GitHub-connection, гигиена workspace, восстановление alert | Нет | live event `heartbeat.run.queued` для timer-tick; канал process-bus `run_queued` | Высокий — тик является композитом ~15 под-свипов, каждый со своим чтением БД; переводить по частям безопаснее, чем разом |
| 3 | `bot_reconcile` | `bot_reconcile` | 60 с (`DEFAULT_RECONCILE_INTERVAL_MS`, env `MYRMIDON_BOT_RECONCILE_INTERVAL_SEC`) | Таблица `agents` (карточки ботов), шлюзовые lease, OOM-события, реестр media ACL, строки rollout-watcher | Нет | канал process-bus `bot_apply_requested` (уже существует для «Apply now»); `settings_changed` для пересборки конфигурации | Средний — свеп идемпотентен, per-bot блокировка уже есть; поверхность событий мала (правки карточки, apply-now, настройки) |
| 4 | fleet memory sync | `bot_reconcile` | 15 мин (`FLEET_MEMORY_SYNC_INTERVAL_MS`) | `myrmidon_fleet_sites`, журнал `myrmidon_fleet_memory_syncs`, карточки ботов | Нет | Сегодня нет — нужен новый сигнал «site memory dirty» или webhook от site-agent | Высокий — pull-модель по дизайну (доска запрашивает экспорт у сайта); перевод на push требует изменения протокола site-agent |
| 5 | fleet replica lane | `bot_reconcile` | 15 мин (`FLEET_REPLICA_INTERVAL_MS`) | `myrmidon_fleet_sites`, манифест replica store, карточки ботов | Нет | Сегодня нет — нужно событие «snapshot ready» от site-agent или расписание на сайте | Высокий — та же pull-модель, что у memory sync; снапшоты большие и идут по одному |
| 6 | site health monitor | `bot_reconcile` | 30 с (`SITE_HEALTH_MONITOR_INTERVAL_MS` = `SITE_HEALTH_POLL_INTERVAL_MS`) | `myrmidon_fleet_sites`, heartbeat-прогоны ботов на потерянных сайтах, списки failed-over / moving ботов | Нет | live event `board.leader_changed` для решений failover; webhook здоровья от site-agent для результатов проб | Средний — проба по своей природе периодична (health check); часть чтения БД (решения failover) может быть событийной, но сама проба — нет |
| 7 | site scheduler lane | `bot_reconcile` | 30 с (`SITE_SCHEDULER_INTERVAL_MS`) | Карточки ботов (`agents`), сайты компании, правила affinity, открытые move, очередь pending-placement | Нет | канал process-bus `settings_changed` (правила affinity живут в настройках); `bot_apply_requested` для правок карточек | Средний — планировщик является чистой функцией от (боты, сайты, правила); набор чтения узкий, источники событий определимы |
| 8 | chat reconcile fallback | `chat_reconcile` | 30 с (`MYRMIDON_CHAT_RECONCILE_FALLBACK_INTERVAL_MS`) | `chat_publications`, `chat_actions`, `heartbeat_runs` (частичные индексы миграции 0296) | Да — `subscribeAllCompanyLiveEvents` → `notifyPublications`, коалесцированный триггер (D3) | Уже переведён; страховочный таймер — это предохранитель | Низкий — это эталонный паттерн (D3), которому должны следовать остальные семь |

## Что делает каждый цикл (одной строкой)

1. **execution_control** — сверяет брошенные execution-control строки,
   безопасные native-замены, доставку статусов, автоматическую диспозицию,
   истёкшие local-AI логины, stall-свеп, pause-guard свеп. Работает только
   на держателе leader-lease.
2. **heartbeat_tick** — композитный тик heartbeat-планировщика: ставит в
   очередь просроченные timer-прогоны, истекает decision, доставляет
   предупреждения provider-usage, обновляет внешние объекты, опрашивает
   GitHub-подключения, свипает workspace и alert. Тоже под гейтом лидера.
3. **bot_reconcile** — сверяет docker-контейнеры ботов доски с карточками
   агентов (образ, env, монтирования, шлюз). Один проход по всем ботам;
   per-bot блокировка не даёт дважды сверить одного бота.
4. **fleet memory sync** — выгружает экспорт рабочей памяти каждого
   доступного удалённого сайта в реплик-банк доски (`fleet-work-replica`).
5. **fleet replica lane** — выгружает файловый снапшот (SQLite datadir)
   каждого бота доступного удалённого сайта в replica store доски.
6. **site health monitor** — пробует каждый зарегистрированный удалённый
   сайт; при потере сайта решает failover (перенос ботов, дрен прогонов,
   карантин); при возврате сайта сверяет контейнеры с реестром.
7. **site scheduler lane** — читает карточки ботов, сайты и правила
   affinity; вердикт чистого планировщика переносит ботов между сайтами
   через state machine переноса, помечает pending-placement или ничего
   не делает.
8. **chat reconcile fallback** — страховочная сетка D3: когда ни одно
   событие публикации чата или вехи не сработало 30 с, запускает один
   коалесцированный проход сверки, который догоняет то, что событийный
   поток пропустил.

## Сырые вызовы `setInterval(` и `backgroundInterval(`

Это не вызовы `laneInterval`, но всё же периодические таймеры, которые
считает ратчет. Полная инвентаризация живёт в базовой карте внутри
`loops-ratchet.myrmidon.test.ts`. Ключевые места:

- `server/src/app.ts` — сброс feedback-export и свеп брошенных
  import-spool (оба под гейтом `backgroundWorkEnabled`).
- `server/src/index.ts` — сверка закрытых задач и backup catch-up (оба
  `backgroundInterval`).
- `server/src/myrmidon/bot-containers/fleet-site-routes.ts` — опрос
  маршрутов сайтов.
- `server/src/myrmidon/chat-reconciliation/reconcile-interval.ts` — сам
  страховочный таймер D3 (`laneInterval` на `chat_reconcile`).
- `server/src/myrmidon/monitoring/board-load/lanes.ts` — сама
  инструментация lane (реализации `laneInterval` и `backgroundInterval`).
- `server/src/services/chat-channels.ts`, `server/src/services/email-channels.ts`
  — таймеры продления lease каналов.
- Множество `backgroundInterval`-свипов по всему `server/src/myrmidon/*` —
  каждый учтён в базовой карте ратчета.

## Как добавить новый таймер

1. Добавьте таймер в код.
2. Запустите
   `pnpm --filter @myrmidon/server exec vitest run src/myrmidon/monitoring/board-load/loops-ratchet.myrmidon.test.ts`
   — тест упадёт и скажет, какой файл не имеет записи в базовой карте.
3. Добавьте строку, описывающую цикл, в этот файл (и `background-loops.md`).
4. Добавьте счётчики файла в `BASELINE` в ратчет-тесте.
5. Перезапустите тест — он должен стать зелёным.

## Как убрать таймер

1. Уберите таймер из кода.
2. Удалите строку файла из `BASELINE` (или уменьшите его счётчики).
3. Удалите строку цикла из этого файла (и `background-loops.md`).
4. Перезапустите ратчет-тест.

## Ссылки

- Дизайн D3 (чаты): `docs/myrmidon/DIVERGENCE.md`, раздел D3.
- Определения lane: `server/src/myrmidon/monitoring/board-load/lanes.ts`.
- Каналы process-bus: `server/src/services/process-bus.ts` (`PROCESS_BUS_CHANNELS`).
- Типы live-event: `packages/shared/src/constants.ts` (`LIVE_EVENT_TYPES`).
