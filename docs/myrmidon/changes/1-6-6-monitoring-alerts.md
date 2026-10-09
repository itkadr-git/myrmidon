## divergence-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: исполнение класса `delete` на DELETE-маршрутах задач -->

### 1.6.6 — вебхук тревог мониторинга (ALERTS)

| ID | Что изменено | Файлы | Зачем | Тесты | Когда снимать | Ссылка |
|---|---|---|---|---|---|---|
| 1.6.6-ALERTS | Вебхук `POST /api/myrmidon/monitoring/alerts/webhook` принимает тревоги Zabbix (media-type payload: eventid/name/severity/status/hosts) и Alertmanager/vm-alertmanager (status, alerts[].labels/fingerprint, startsAt/endsAt). Идентичность тревоги — (источник, ключ: Zabbix eventid / Alertmanager fingerprint); повторная открытая тревога дописывает коммент в существующую задачу вместо дубля, восстановление (Zabbix status=Resolved / Alertmanager resolved+endsAt) закрывает задачу автоматически комментом «восстановлено» через существующий сервис задач. Assignee — из карты «тип тревоги → роль/агент» в `instance_settings.general` (`GET/PATCH /api/myrmidon/monitoring/alerts/settings`), дефолт — adm-devops. Авторизация — токен-секрет по ссылке `env:/file:` (`MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF`, паттерн maintenance/zabbix), значение не логируется и не возвращается. Состояние дедупа — JSON-ключ в `instance_settings.general`, без новых таблиц; чистка закрытых записей свипом `startAlertsSweep` по возрасту | `server/src/app.ts` (импорт + одна строка монтирования с меткой `myrmidon(1.6.6-ALERTS)`), `server/src/index.ts` (импорт + одна строка старта свипа с меткой) + наши файлы `server/src/myrmidon/monitoring/alerts/{domain,settings,store,service,routes,token,sweep,index}.ts` | Тревога «диск > 90 %» из Zabbix должна становиться задачей роли за минуту и закрываться сама после исправления (трек 1.6.6 MONITORING) | `server/src/myrmidon/monitoring/alerts/guard.myrmidon.test.ts`, `domain.myrmidon.test.ts`, `routes.myrmidon.test.ts`, `token.myrmidon.test.ts` | Никогда, наше поведение: вендор не принимает вебхуки внешних систем мониторинга. Снять целиком: удалить метки `myrmidon(1.6.6-ALERTS)` в app.ts/index.ts, модуль и тесты | (этот PR) |

## settings-en-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: matrix enforcement tests and route mapping -->

### 1.6.6 — ALERTS: monitoring alerts webhook (Zabbix + Alertmanager)

Settings of `server/src/myrmidon/monitoring/alerts/` — the monitoring alerts
webhook. `POST /api/myrmidon/monitoring/alerts/webhook` accepts alerts from
Zabbix (media-type webhook payload: eventid/name/severity/status/hosts) and
Alertmanager/vm-alertmanager (JSON: status, alerts[].labels/fingerprint,
startsAt/endsAt). Identity is (source, key): Zabbix eventid / Alertmanager
fingerprint. A repeated open alert appends a comment to the EXISTING issue
(no duplicate); a resolution (Zabbix status=Resolved / Alertmanager
resolved+endsAt) auto-closes the issue with a "restored" comment via the
existing issue service. Assignee comes from the alert-type-to-role map in
`instance_settings.general` (`GET/PATCH /api/myrmidon/monitoring/alerts/settings`),
default `adm-devops`. Dedup state lives in a JSON key in
`instance_settings.general` — no new tables; closed entries are swept by
`startAlertsSweep` by age.

| Variable | Feature | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF` | 1.6.6-ALERTS | unset | Reference to the webhook token of the monitoring alerts endpoint (`POST /api/myrmidon/monitoring/alerts/webhook`): `env:<NAME>` (variable) or `file:<PATH>` (a file, e.g. a Docker secret). The value is compared in memory and never logged or returned | Unset — the webhook answers 503, no alerts are accepted |
| `MYRMIDON_ALERTS_COMPANY_ID` | 1.6.6-ALERTS | unset | Company id whose board receives the monitoring alert issues; the settings read falls back to it when no `companyId` query is given | Unset — the webhook answers 503 |
| `MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC` | 1.6.6-ALERTS | `3600` | Interval of the dedup registry sweep that drops closed alert entries | `0` disables the sweep; clamped to 86400 |
| `MYRMIDON_ALERTS_RETENTION_DAYS` | 1.6.6-ALERTS | `14` | Age of the last registry update after which a closed entry is dropped | Clamped to 365 |
