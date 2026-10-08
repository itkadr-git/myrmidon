---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### 1.6.6 MONITORING E: service keys of the linking components and the "I am alive" self-check (OPE-4973)

- New board key scope `monitoring_link`: the narrowest key on the board. A
  linking component (Zabbix aggregator, Alertmanager webhook, collector) gets
  its own key that can only create a task, update a task and report its own
  liveness — never the shared operator key.
- `POST /api/myrmidon/companies/:companyId/monitoring/links/pulse` — the
  link's "I am alive". The key identifies the link; a 200 is the board
  answering "I hear you". The pulse is the key's own `last_used_at`, so a
  second heartbeat store cannot disagree with the first.
- `GET /api/myrmidon/companies/:companyId/monitoring/links` — the live feed
  (`keyState`, `lastPulseAt`, `pulseAgeSec`, `staleAfterSec`, `verdict`,
  `unhealthy`) that the Zabbix item and the operator read.
- Board-side watchdog: a revoked or expired key, or a link that stopped
  pulsing, raises **one High task** for the observability role and closes it
  with a comment when the link is back. A task closed by a human while the link
  is still blind is reopened.
- Detection budget: the default 480s silence threshold plus the 60s pass and
  the 30s scheduler tick put the worst case at 570s — inside the ten minutes the
  issue asks for. A key that dies on the fly is caught on the next pass.
- A link key is confined to the company it was issued for and no longer follows
  its owner user's membership list into other tenants; an unreadable stored
  scope degrades to `read_only` instead of widening to full operator access.

## changelog-ru

### 1.6.6 MONITORING E: сервисные ключи связующих звеньев и самопроверка «я живой» (OPE-4973)

- Новый скоуп ключа доски `monitoring_link` — самый узкий на доске. Связующее
  звено (агрегатор Zabbix, вебхук Alertmanager, сборщик) получает свой ключ,
  который умеет только создать задачу, обновить задачу и сообщить о своей
  живости — вместо общего ключа оператора.
- `POST /api/myrmidon/companies/:companyId/monitoring/links/pulse` — «я живой»
  звена. Звено называет себя своим ключом; ответ 200 — это доска, отвечающая
  «слышу тебя». Пульс — это `last_used_at` самого ключа, поэтому второе
  хранилище пульсов не может разойтись с первым.
- `GET /api/myrmidon/companies/:companyId/monitoring/links` — живая лента
  (`keyState`, `lastPulseAt`, `pulseAgeSec`, `staleAfterSec`, `verdict`,
  `unhealthy`), которую читают элемент Zabbix и оператор.
- Сторож на стороне доски: отозванный или протухший ключ либо замолчавшее звено
  поднимают **одну задачу High** роли observability, а при возвращении звена в
  строй она закрывается с комментарием. Задачу, закрытую человеком при всё ещё
  слепом звене, сторож переоткрывает.
- Бюджет обнаружения: порог тишины 480 с по умолчанию плюс проход 60 с и тик
  планировщика 30 с дают худший случай 570 с — внутри десяти минут из
  постановки. Ключ, умерший на ходу, ловится на ближайшем проходе.
- Ключ звена ограничен своей компанией и не наследует список членств своего
  пользователя-владельца; нечитаемый скоуп в хранилище откатывается на
  `read_only`, а не расширяется до полного операторского доступа.

## divergence

| 1.6.6-MONITORING-E | Скоуп ключа доски `monitoring_link`: ключ звена умеет создать задачу, обновить задачу и отправить пульс, и ничего больше. Method-aware разбор путей в `boardApiKeyScopeAllows` (`monitoringLinkAllows`): POST на создание задачи, PATCH/PUT на обновление, POST на пульс, GET на ленту; скоуп исключён из общих карт `MUTATION_ALLOWLIST`/`COMPANY_NESTED_MUTATIONS`, чтобы новое право не появилось само при расширении вендорских путей. Дополнительно ключ звена ограничен своей компанией в `assertCompanyAccess`/`hasCompanyAccess`; нечитаемый скоуп хранилища откатывается на `read_only` (было — на `full`). API: `POST /api/myrmidon/companies/:companyId/monitoring/links/pulse`, `GET /api/myrmidon/companies/:companyId/monitoring/links`. Сторож поднимает одну задачу High роли observability на пару (ключ, причина) по ключу идемпотентности, закрывает её при возвращении звена и переоткрывает закрытую человеком, пока звено слепо | `packages/shared/src/validators/access.ts`, `server/src/middleware/board-key-scope.ts`, `server/src/routes/authz.ts`, `server/src/app.ts`, `server/src/index.ts`, `ui/src/pages/BoardApiKeys.tsx` (все с меткой `myrmidon(1.6.6 MONITORING E)`) + `server/src/myrmidon/monitoring/links/{health,alert,store,watchdog,routes,index}.ts` | Эпик 1.6.6 MONITORING, часть E, повод — 02–06.10 агрегатор High был слеп четыре дня: общий ключ звена умер, все запросы звена получали 401, и об этом никто не узнал. Доска должна сама замечать слепоту звена, а не полагаться на канал, который молчит вместе со звеном | `server/src/myrmidon/monitoring/links/monitoring-links.test.ts` (вердикты revoked/expired/no_pulse/healthy и их приоритет; неиспользованный ключ считается от времени выдачи; граница порога тишины; один ключ идемпотентности на пару (ключ, причина); протухший ключ и замолчавшее звено дают тревогу High в пределах десяти минут на сжатых часах с реальными тиками; переоткрытие закрытой тревоги; возвращение звена закрывает три тревоги; падение одной строки не останавливает проход), `server/src/__tests__/board-key-scope-middleware.test.ts` (звено: создаёт/обновляет задачу и шлёт пульс; не доходит до агентов, секретов, приглашений, обслуживания, плагинов и удаления задач; читает только ленту и задачи своей компании; повреждённый скоуп — не мутация, только чтение), `server/src/__tests__/board-key-tenant-confinement.test.ts` (ключ звена только в своей компании; чужая — отказ, а по-id — 404; другие ключи на прежнем правиле членств), `packages/shared/src/validators/board-api-key-scope.test.ts` (форма скоупа звена, `isMonitoringLinkScope`, откат нечитаемого скоупа на `read_only`) | Никогда, наше поведение. Снятие: удалить модуль `server/src/myrmidon/monitoring/links`, вызовы `scheduleMonitoringLinkSweep` и монтирование `myrmidonMonitoringLinkRoutes`, строки с меткой `myrmidon(1.6.6 MONITORING E)` в вендорских файлах, вид `monitoring_link` из таксономии скоупов и `docs/myrmidon/monitoring-links.md` | (этот PR) |
| 1.6.6-MONITORING-E | Сторож звеньев идёт тиком планировщика сердцебиения (`scheduleMonitoringLinkSweep` рядом с прочими myrmidon-свипами, свой шаг 60 с) и читает звенья из строк `board_api_keys` со скоупом `monitoring_link` — отдельной таблицы звеньев нет, звено и есть его ключ. Порог тишины живёт в самом скоупе (`staleAfterSec`, по умолчанию 480) | `server/src/index.ts`, `server/src/app.ts` + `server/src/myrmidon/monitoring/links/{store,watchdog}.ts` | Слепота звена должна обнаруживаться на доске, а не в Zabbix: канал оповещения умер вместе с ключом, поэтому сторож обязан выживать и смерть канала, и смерть ключа, и смерть звена. Второй таблицы нет намеренно — она могла бы разойтись с фактом использования ключа | `server/src/myrmidon/monitoring/links/monitoring-links.test.ts` (пропуск прохода внутри своего интервала и обход по `force`; лента сортирована по имени звена; падение списка ключей отдаётся результатом, а не исключением в планировщик; арифметика бюджета обнаружения) | Никогда, наше поведение. Снимание — вместе со всем 1.6.6-MONITORING-E (см. строку выше) | (этот PR) |