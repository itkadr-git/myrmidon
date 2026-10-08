---
divergence-section: Трек 4 — чаты и навыки
---

## changelog-en

### Chat reconciliation asks a cheap "is there work" gate before each lane (DB-PERF-C-P5)

- The chat reconciliation coordinator ticks once a second and ran every durable
  lane on every tick, whether or not the lane had anything to do. Measured over
  04–06.10 on the production database: the run-milestone projection 37k calls ×
  58.7 ms (≈2197 s CPU), the `chat_actions`/`agent_wakeup_requests` sweeps 34k ×
  74.6 ms (≈2556 s CPU) and ~921k sequential scans over `chat_publications`
  (~1.65e9 tuples) — ≈5.5k s of CPU in a 13.6 h window while the queues were
  almost always empty.
- Every gated lane now answers one cheap question first, with ONE statement of
  the shape `select 1 where <probe> limit 1` over the lane's own outbox (module
  `server/src/myrmidon/chat-reconciliation/work-gates.ts`): the publication
  flush probes the due `chat_publications` rows (`chat_publications_work_idx`),
  the delivery lane probes `chat_deliveries` plus every `chat_actions` kind it
  drains (`chat_deliveries_work_idx`,
  `chat_actions_inbound_wakeup_sweep_idx`), the Slack lanes probe their own
  `chat_actions` kind, and the run-milestone lane probes runs of live chat
  conversations updated after the last completed pass
  (`heartbeat_runs_company_ctx_issue_created_idx`). A gate that answers "no
  work" skips its lane for that tick.
- The probes are deliberately conservative: a probe may report work for a queue
  that turns out to be empty (the lane then behaves exactly as before), never
  the other way round. Nothing was rewritten inside the lanes themselves.
- `notifyPublications()` — the live "a publication was committed" signal —
  bypasses both gates for exactly one forced pass of the publication and
  milestone lanes, so a fresh commit cannot wait for the next tick that happens
  to have other work. Periodic recovery polls do not force anything.
- The run-milestone lane keeps a watermark of its last completed pass in
  process memory. The first tick after a start/restart is always a full pass
  (nothing accumulated while the process was down is lost), a pass that
  inserted anything does not move the watermark (the projection may have
  stopped at its own row budget with older candidates still unprocessed), and
  one full pass per 10 minutes bounds the delay of a candidate that becomes
  eligible without a run being updated.
- The Telegram-notify proactivity sweep used to sit in front of the publication
  flush inside the same lane. It is a producer for that queue, so it moved to
  its own lane and keeps its cadence while the flush is gated.
- The publication lane also runs two notice producers
  (`enqueueInboundWakeupPublications`, `enqueueFailedChatRetryPublications`)
  whose condition is "a settled wakeup whose notice publication is still
  missing". That one question cannot be asked inside a cheap index probe — it
  costs a scan of the whole settled-wakeup population plus one publication
  probe per row, and measured slower than the sweep it would replace — so the
  lane reaches those producers through a safety window instead: one forced pass
  every 5 seconds. An idle instance therefore pays for the sweep a fifth as
  often (a fifth of its previous share of the tick), and a notice waits at most
  that window; any other publication work, or a live commit signal, opens the lane
  immediately.
- Left ungated on purpose: provider-runtime reconciliation, GitHub webhook
  delivery recovery, and the periodic Telegram endpoint state-repair staging
  inside `processPendingTelegramMaintenance` (its condition is a
  runtime-derived scope that SQL cannot reproduce, and the same staging is
  reached from the endpoint lifecycle paths).
- No migration: the gates use the index set of the release they land in.

## changelog-ru

### Сверка чатов спрашивает дешёвый гейт «есть работа» перед каждым лейном (DB-PERF-C-P5)

- Координатор сверки чатов тикает раз в секунду и гонял каждый тяжёлый лейн на
  каждом тике, была у лейна работа или нет. Замер 04–06.10 на боевой базе:
  проекция вех прогона 37 тыс. вызовов × 58,7 мс (≈2197 с CPU), сводки
  `chat_actions`/`agent_wakeup_requests` 34 тыс. × 74,6 мс (≈2556 с CPU) и
  ~921 тыс. последовательных сканов `chat_publications` (~1,65 млрд кортежей) —
  ≈5,5 тыс. с CPU за окно 13,6 ч при почти всегда пустых очередях.
- Теперь каждый закрытый гейтом лейн сначала получает ответ на один дешёвый
  вопрос — ОДНИМ запросом вида `select 1 where <предикат> limit 1` по своей
  очереди (модуль `server/src/myrmidon/chat-reconciliation/work-gates.ts`):
  сброс публикаций проверяет готовые строки `chat_publications`
  (`chat_publications_work_idx`), лейн доставок — `chat_deliveries` и все виды
  `chat_actions`, которые он разбирает (`chat_deliveries_work_idx`,
  `chat_actions_inbound_wakeup_sweep_idx`), лейны Slack — свой вид
  `chat_actions`, лейн вех — прогоны живых чатов, обновлённые после последнего
  завершённого прохода (`heartbeat_runs_company_ctx_issue_created_idx`). Ответ
  «работы нет» пропускает лейн на этом тике.
- Предикаты намеренно консервативны: гейт может сказать «работа есть» для
  пустой очереди (тогда лейн ведёт себя ровно как раньше), но не наоборот. Сами
  лейны не переписаны.
- `notifyPublications()` — живой сигнал «публикация закоммичена» — обходит оба
  гейта ровно на один принудительный проход лейнов публикаций и вех, чтобы
  свежий коммит не ждал следующего тика, на котором найдётся другая работа.
  Периодический опрос ничего не форсирует.
- Лейн вех держит в памяти процесса отметку последнего завершённого прохода.
  Первый тик после старта/перезапуска — всегда полный проход (накопленное за
  время простоя не теряется), проход, что-то вставивший, отметку не двигает
  (проекция могла упереться в свой лимит строк, оставив более старые
  кандидаты), а один полный проход раз в 10 минут ограничивает задержку
  кандидата, который стал пригодным без обновления прогона.
- Сводка проактивных сообщений Telegram раньше стояла в том же лейне перед
  сбросом публикаций. Она — производитель для этой очереди, поэтому переехала в
  свой лейн и сохраняет частоту, пока сброс закрыт гейтом.
- В лейне публикаций живут ещё два производителя уведомлений
  (`enqueueInboundWakeupPublications`, `enqueueFailedChatRetryPublications`),
  их условие — «есть осевший wakeup, для которого ещё нет публикации
  уведомления». Этот вопрос нельзя задать дешёвым индексным зондом: он стоит
  проход по всей популяции осевших wakeup плюс зонд публикации на строку и на
  замере оказался дороже той сводки, которую заменяет. Поэтому лейн добирается
  до этих производителей через безопасное окно: один принудительный проход раз
  в 5 секунд. Пустой инстанс платит за сводку в пять раз реже, а уведомление
  ждёт не дольше окна; любая другая работа по публикациям или живой сигнал
  коммита открывают лейн сразу.
- Специально без гейтов: сверка провайдерских рантаймов, восстановление
  доставки GitHub-вебхуков и периодическая постановка ремонта состояния
  Telegram-эндпоинтов внутри `processPendingTelegramMaintenance` (её условие —
  вычисляемая в рантайме область, которую SQL не воспроизводит, а та же
  постановка приходит и с событий жизненного цикла эндпоинта).
- Миграции нет: гейты используют набор индексов того релиза, в который
  попадают.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| DB-PERF-C-P5 | Перед запуском тяжёлого лейна сверки чатов координатор спрашивает дешёвый гейт «есть работа» (`select 1 … limit 1` по очереди лейна, модуль `server/src/myrmidon/chat-reconciliation/work-gates.ts`) и пропускает лейн на этом тике, если работы нет; `notifyPublications()` будит лейны публикаций и вех минуя гейт ровно на один проход; лейн вех ведёт в памяти процесса отметку последнего завершённого прохода (старт процесса — полный проход, вставивший проход отметку не двигает, раз в 10 минут — полный проход для ограничения задержки); сводка проактивных сообщений Telegram выделена в отдельный лейн, чтобы гейт сброса публикаций её не останавливал. Лейн публикаций добирается до двух производителей уведомлений через безопасное окно — один принудительный проход раз в 5 секунд (условие этих производителей не сводится к дешёвому индексному зонду). Без переданных гейтов поведение вендорское, лейн за лейном | `server/src/app.ts` (фабрика `createChatReconciliationCoordinator`: необязательные входы `workGates` и `sweepTelegramNotifyProactivity`, имя лейна и точки вызова; проводка в `startServer`), метки `myrmidon(DB-PERF-C-P5)` | Пункт П5 аудита базы (документ db-audit, 04.10): секундный тик стоит ≈5,5 тыс. с CPU за 13,6 ч на почти пустых очередях | `server/src/myrmidon/chat-reconciliation/work-gates.myrmidon.test.ts`, `server/src/myrmidon/chat-reconciliation/coordinator-work-gates.myrmidon.test.ts` | Никогда (наше решение по цене пустого тика). Снимать: убрать передачу `workGates` в проводке `startServer` — координатор вернётся к запуску всех лейнов каждый тик; при переносе сверить `grep -rn 'myrmidon(DB-PERF-C-P5)'` | (PR) |