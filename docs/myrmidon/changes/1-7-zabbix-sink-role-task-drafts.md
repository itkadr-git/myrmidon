## changelog-en

### 1.7 ZABBIX-SINK: Zabbix alarm webhook creates a role-task draft (OPE-12126)

- New endpoint `POST /api/monitoring/zabbix-webhook`: one Zabbix media-type event per request becomes a role-task draft on the board — the issue title comes from the trigger name, the priority from the Zabbix severity (5/4 → critical, 3 → high, 2 → medium, else low), the Zabbix event URL lands in the issue body as the source link.
- Dedup identity is the Zabbix `eventid`: a redelivery returns the existing draft (`action: "dedup"`) instead of creating a second task. The registry lives in a JSON key of `instance_settings.general` — no new tables, no migration.
- An invalid payload (no `eventid`, no `name`, a resolved/closed status, not an object) answers 400 without guessing.
- Auth is a webhook token by reference (`MYRMIDON_ZABBIX_SINK_TOKEN_REF`, `env:`/`file:` pattern of the alerts webhook); the token is a stub since 1.7, to be replaced by the signed intake. Unset reference or company answers 503.

## changelog-ru

### 1.7 ZABBIX-SINK: вебхук тревог Zabbix создаёт черновик задачи роли (OPE-12126)

- Новый эндпоинт `POST /api/monitoring/zabbix-webhook`: одно событие media-type вебхука Zabbix превращается в черновик задачи роли на доске — заголовок задачи из имени триггера, приоритет из серьёзности Zabbix (5/4 → critical, 3 → high, 2 → medium, иначе low), ссылка на событие Zabbix попадает в описание задачи как источник.
- Идентичность дедупликации — `eventid` Zabbix: повторная доставка возвращает существующий черновик (`action: "dedup"`) вместо второй задачи. Реестр хранится в JSON-ключе `instance_settings.general` — без новых таблиц и миграций.
- Невалидный payload (нет `eventid`, нет `name`, статус resolved/closed, не объект) отвечает 400 без догадок.
- Авторизация — токен вебхука по ссылке (`MYRMIDON_ZABBIX_SINK_TOKEN_REF`, паттерн `env:`/`file:` вебхука алертов); с 1.7 токен — заглушка до подписанного приёма. Не заданы ссылка или компания — 503.

## divergence-new

<!-- after: 1.6.6 — MONITORING: метрики простоя инженеров для Zabbix (OPE-9868 / OPE-10927) -->

### 1.7 — ZABBIX-SINK: приём Zabbix-тревоги в задачу роли (OPE-12126)

| ID | Что изменено | Файлы | Зачем | Тест-сторож | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.7-ZABBIX-SINK | Вебхук `POST /api/monitoring/zabbix-webhook` принимает одно событие Zabbix (media-type payload: eventid/name/severity/status/hosts/url) и создаёт черновик задачи роли: title из имени триггера, priority из серьёзности (5/4 → critical, 3 → high, 2 → medium, иначе low), ссылка на событие — источник в описании. Дедуп по `eventid`: повторная доставка возвращает существующий черновик (JSON-реестр в `instance_settings.general`, без новых таблиц), невалидный payload — 400. Авторизация — токен по ссылке `env:`/`file:` (`MYRMIDON_ZABBIX_SINK_TOKEN_REF`, паттерн alerts/token.ts); с 1.7 токен-заглушка до подписанного приёма. Сервис дедупа сериализует параллельные первые доставки одного eventid | `server/src/app.ts` (импорт + одна строка монтирования с меткой `myrmidon(1.7-ZABBIX-SINK / OPE-12126)`), `server/src/myrmidon/app-plugin.ts` + наши файлы `server/src/myrmidon/monitoring/zabbix-sink/{domain,service,store,routes,index}.ts` | Тревога Zabbix должна становиться задачей роли без ручного шага (roadmap-v1 §3.3, эпик OPE-2913); в отличие от 1.6.6-ALERTS черновик не привязан к карте исполнителей — задачу разбирает любая свободная роль | `server/src/myrmidon/monitoring/zabbix-sink/routes.myrmidon.test.ts` | Никогда, наше поведение: вендор не превращает тревоги в черновики задач. Снять целиком: удалить метки `myrmidon(1.7-ZABBIX-SINK)` в app.ts/app-plugin.ts, модуль и тесты | (этот PR) |

## settings-en-new

<!-- after: 1.6.6 — ALERTS: monitoring alerts webhook (Zabbix + Alertmanager) -->

### 1.7 — ZABBIX-SINK: Zabbix alarm sink to role-task drafts (OPE-12126)

Settings of `server/src/myrmidon/monitoring/zabbix-sink/` — the Zabbix alarm
sink. `POST /api/monitoring/zabbix-webhook` accepts one Zabbix media-type
event (eventid/name/severity/status/hosts/url) per request and creates a
role-task draft: the title comes from the trigger name, the priority from the
Zabbix severity, the event URL lands in the issue body as the source link.
Dedup identity is the `eventid`: a redelivery returns the existing draft, the
registry lives in a JSON key of `instance_settings.general` (no new tables).
An invalid payload answers 400. Unlike the 1.6.6-ALERTS webhook, the draft
stays unassigned — a free role claims it on the board.

| Variable | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_ZABBIX_SINK_TOKEN_REF` | 1.7-ZABBIX-SINK | unset | Reference to the webhook token of the Zabbix sink endpoint (`POST /api/monitoring/zabbix-webhook`): `env:<NAME>` (variable) or `file:<PATH>` (a file, e.g. a Docker secret). The value is compared in memory and never logged or returned. Since 1.7 the token is a stub pending the signed intake | Unset — the webhook answers 503, no events are accepted |
| `MYRMIDON_ALERTS_COMPANY_ID` | 1.7-ZABBIX-SINK | unset | Company id whose board receives the sink drafts (shared with the 1.6.6-ALERTS webhook) | Unset — the webhook answers 503 |

## settings-ru-new

<!-- after: 1.6.6 — ALERTS: вебхук мониторинговых тревог (Zabbix + Alertmanager) -->

### 1.7 — ZABBIX-SINK: приём Zabbix-тревоги в задачу роли (OPE-12126)

Настройки `server/src/myrmidon/monitoring/zabbix-sink/` — стока тревог Zabbix.
`POST /api/monitoring/zabbix-webhook` принимает одно событие media-type вебхука
Zabbix (eventid/name/severity/status/hosts/url) и создаёт черновик задачи роли:
заголовок из имени триггера, приоритет из серьёзности Zabbix, ссылка на событие
попадает в описание задачи как источник. Идентичность дедупликации — `eventid`:
повторная доставка возвращает существующий черновик, реестр хранится в
JSON-ключе `instance_settings.general` (без новых таблиц). Невалидный payload —
400. В отличие от вебхука 1.6.6-ALERTS черновик остаётся без исполнителя —
задачу забирает свободная роль на доске.

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_ZABBIX_SINK_TOKEN_REF` | 1.7-ZABBIX-SINK | не задана | Ссылка на токен вебхука стока Zabbix (`POST /api/monitoring/zabbix-webhook`): `env:<ИМЯ>` (переменная) или `file:<ПУТЬ>` (файл, например Docker secret). Значение сравнивается в памяти и никогда не пишется в лог и не возвращается. С 1.7 токен — заглушка до подписанного приёма | Не задана — вебхук отвечает 503, события не принимаются |
| `MYRMIDON_ALERTS_COMPANY_ID` | 1.7-ZABBIX-SINK | не задана | Идентификатор компании, на чьей доске появляются черновики стока (общий с вебхуком 1.6.6-ALERTS) | Не задана — вебхук отвечает 503 |

