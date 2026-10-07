## changelog-en

### Alert recovery: the owner task of an alarm and the automatic close (1.6.6-MONITORING-D)

- An alarm from Zabbix or Alertmanager now becomes a task of the owning role
  instead of a thread of messages: the task carries the numbered recovery steps
  of the runbook of that trigger, the link to its document, and the metric the
  owner checks when the steps are done. A trigger with no runbook of its own
  falls back to the generic runbook, which still ships steps and a document.
- The runbook registry (`server/src/myrmidon/monitoring/alert-recovery/runbook.ts`)
  selects by trigger key: an exact trigger match first, then the longest matching
  fragment (`disk`, `filesystem`, `space` → `disk-space-low`; `unreachable`,
  `icmp`, `zabbix agent` → `host-unreachable`; `scrape`, `prometheus` →
  `metrics-scrape-failing`). The documents live in `docs/myrmidon/runbooks/` and
  a test fails if a registered runbook has no document on disk.
- The task closes by itself once the alarm has stayed resolved for the hold
  (10 minutes by default): the scheduler tick closes it, comments the metric and
  the resolve time, and only ever writes to tasks it opened itself
  (`originKind = alert_recovery`), so a task a person took over is never
  overruled.
- A repeat alarm inside the recurrence window (60 minutes by default) comes back
  into the same task — a comment, the task is reopened if it had already closed —
  instead of opening a second one. A repeat before the hold is up cancels the
  automatic close and the hold restarts from the next resolve. A resolve event
  that arrives twice does not push the close away.
- Both numbers are instance settings, changed live through
  `GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (PATCH is instance-admin,
  the same rule as the rest of the instance settings), stored in
  `instance_settings.general.alertRecovery`, read over the environment on every
  event and every sweep pass. The GET reports, per key, whether the settings row,
  the environment or the default is in force, plus the runbook registry and the
  alert journal of the company with the due time of every automatic close.
- An operator or the intake can drive a real alarm through the lifecycle with
  `POST /api/myrmidon/monitoring/alert-recovery/events` — the normalized event
  (source, trigger, status, severity, hosts, time) that the Zabbix/Alertmanager
  intake of the monitoring part produces once an alarm fires again or resolves.
- Every settings change is written to the activity log for every company
  (`instance.alert_recovery.updated`).

## changelog-ru

### Восстановление по тревоге: задача роли-владельца и автозакрытие (1.6.6-MONITORING-D)

- Тревога из Zabbix или Alertmanager теперь становится задачей роли-владельца,
  а не потоком сообщений: задача несёт нумерованные шаги восстановления из
  рунбука этой тревоги, ссылку на его документ и метрику, которую владелец
  проверяет после шагов. Для тревоги без своего рунбука работает общий: он тоже
  несёт шаги и документ.
- Реестр рунбуков
  (`server/src/myrmidon/monitoring/alert-recovery/runbook.ts`) выбирает рунбук
  по ключу тревоги: сначала точное совпадение, затем самый длинный подходящий
  фрагмент (`disk`, `filesystem`, `space` → `disk-space-low`; `unreachable`,
  `icmp`, `zabbix agent` → `host-unreachable`; `scrape`, `prometheus` →
  `metrics-scrape-failing`). Документы лежат в `docs/myrmidon/runbooks/`, и тест
  падает, если у зарегистрированного рунбука нет документа на диске.
- Задача закрывается сама, когда тревога продержится снятой заданное число
  минут (по умолчанию 10): проход планировщика закрывает её, пишет в неё
  метрику и время снятия — и трогает только те задачи, что открыл сам
  (`originKind = alert_recovery`), поэтому задачу, которую взял в работу
  человек, он не перебивает.
- Повторная тревога в пределах окна возврата (по умолчанию 60 минут)
  возвращается в ту же задачу — комментарием, а если она уже закрылась, то
  возвратом в работу — и не открывает вторую. Повтор до истечения удержания
  отменяет автозакрытие, и удержание начинается заново со снятия. Событие
  снятия, пришедшее дважды, автозакрытие не отодвигает.
- Оба числа — настройки инстанса, меняются на живой доске через
  `GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (PATCH — только
  администратор инстанса, как и остальные настройки инстанса), хранятся в
  `instance_settings.general.alertRecovery` и читаются поверх окружения на
  каждом событии и каждом проходе. GET отдаёт по каждому ключу, что в силе —
  строка настроек, окружение или умолчание, — а также реестр рунбуков и журнал
  тревог компании со сроком каждого автозакрытия.
- Оператор или приёмник тревог может провести реальную тревогу по всему циклу
  через `POST /api/myrmidon/monitoring/alert-recovery/events` — нормализованное
  событие (источник, триггер, состояние, важность, хосты, время), которое
  приёмник Zabbix/Alertmanager из части MONITORING выдаёт при повторном
  срабатывании и при снятии.
- Каждое изменение настроек пишется в журнал активности по каждой компании
  (`instance.alert_recovery.updated`).

## divergence-new

<!-- after: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов -->
### 1.6.6 — MONITORING D: шаги восстановления в задаче по тревоге и автозакрытие

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| 1.6.6-MONITORING-D | Тревога становится задачей роли-владельца: реестр рунбуков выбирает рунбук по ключу триггера, задача несёт шаги и документ, автозакрытие после устойчивого снятия тревоги, повтор в окне — в ту же задачу. Состояние — два ключа общего раздела настроек (`instance_settings.general.alertRecovery`, `alertRecoveryJournal`), маршруты `GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` и `POST .../events`, проход закрытия — шаг тика | `packages/shared/src/index.ts` (экспорт модуля), `packages/shared/src/validators/instance.ts` (два ключа в схеме общих настроек), `packages/shared/src/types/instance.ts` (два поля `InstanceGeneralSettings`), `server/src/app.ts` (монтирование роутера), `server/src/index.ts` (шаг тика `scheduleAlertRecoverySweep`; метка `myrmidon(1.6.6-MONITORING-D)`) | Вендорская запись общих настроек молча выбрасывает ключ, которого нет в схеме общих настроек, а маршруты и шаг тика — точки подключения вендорских файлов; сам модуль живёт отдельно и вендорских решений не меняет | `server/src/myrmidon/monitoring/alert-recovery/lifecycle.myrmidon.test.ts` (весь цикл: тревога → задача, повтор в ту же задачу, автозакрытие после удержания, возврат в окне, новая задача вне окна, документы реестра на диске) | Снять монтирование и шаг тика из `server/src/app.ts` и `server/src/index.ts`, удалить два ключа из `packages/shared/src/validators/instance.ts` и `types/instance.ts` и экспорт модуля; строка настроек останется в базе неиспользованной | — |

## settings-en-new

<!-- after: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->
### 1.6.6 — MONITORING D: alert recovery

An alarm (Zabbix / Alertmanager) opens one task of the owning role with the
recovery steps of the runbook of its trigger, and the task closes by itself once
the alarm has stayed resolved for the hold. Both numbers live in
`instance_settings.general.alertRecovery` and are changed live on
`GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (GET is any board member of
the company, PATCH is instance-admin). Precedence is per key: the stored value,
else the environment variable, else the default; the GET reports which layer is
in force. The document of every runbook is the operator's reference:
`docs/myrmidon/runbooks/`.

| Variable / stored key | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES` / `holdMinutes` | 1.6.6-MONITORING-D | `10` | How many minutes an alarm must stay resolved before the task closes by itself. The sweep of every scheduler tick compares the resolve time with this window, so the close happens on the first tick after the hold | A non-integer or a value outside 1–1440 — the default. Set it very high (e.g. `1440`) to make the close practically manual; a stored row that does not validate is ignored as a whole |
| `MYRMIDON_ALERT_RECOVERY_WINDOW_MINUTES` / `recurrenceWindowMinutes` | 1.6.6-MONITORING-D | `60` | The recurrence window: an alarm of the same trigger (source + trigger + hosts) that fires again within this window after the automatic close comes back into the same task instead of opening a new one. A record outlives the window by this much and is then dropped by the sweep | A non-integer or a value outside 1–10080 — the default. The minimum (`1`) is as close to «never group a repeat» as the setting goes: only an alarm of the same trigger inside one minute rejoins |
| `owners` (stored only) | 1.6.6-MONITORING-D | the runbook's role | Per-trigger owner role: `{ "disk /data": "devops" }` names the role the task is opened for, overriding the role the runbook carries. The role must exist as a caste key of the company; the task is assigned to an agent of that role | A patch merges into the map, so an owner is redirected by sending another role, not removed; send the runbook's own role to go back. A role with no agent in the company leaves the task unassigned and the task body says so |

## settings-ru-new

<!-- after: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->
### 1.6.6 — MONITORING D: восстановление по тревоге

Тревога (Zabbix / Alertmanager) открывает одну задачу роли-владельца с шагами
восстановления из рунбука этой тревоги, а задача закрывается сама, когда тревога
продержится снятой заданное число минут. Оба числа лежат в
`instance_settings.general.alertRecovery` и меняются на живой доске через
`GET`/`PATCH /api/myrmidon/monitoring/alert-recovery` (GET — любой член правления
компании, PATCH — администратор инстанса). Приоритет по ключу: сохранённое
значение, иначе переменная окружения, иначе умолчание; GET показывает, какой
слой в силе. Документ каждого рунбука — справочник оператора:
`docs/myrmidon/runbooks/`.

| Переменная / сохранённый ключ | Функция | Умолчание | Что делает | Как выключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES` / `holdMinutes` | 1.6.6-MONITORING-D | `10` | Сколько минут тревога должна продержаться снятой, прежде чем задача закроется сама. Проход каждого тика планировщика сравнивает время снятия с этим окном, поэтому закрытие происходит на первом тике после удержания | Нецелое или значение вне 1–1440 — умолчание. Очень большое значение (например `1440`) делает закрытие практически ручным; сохранённая строка, не проходящая проверку, игнорируется целиком |
| `MYRMIDON_ALERT_RECOVERY_WINDOW_MINUTES` / `recurrenceWindowMinutes` | 1.6.6-MONITORING-D | `60` | Окно возврата: тревога того же триггера (источник + триггер + хосты), сработавшая в пределах этого окна после автозакрытия, возвращается в ту же задачу, а не открывает новую. Запись живёт ещё столько же после окна и затем снимается проходом | Нецелое или значение вне 1–10080 — умолчание. Минимум (`1`) — это самое близкое к «не объединять повтор»: в ту же задачу вернётся только тревога того же триггера в пределах минуты |
| `owners` (только сохранённый) | 1.6.6-MONITORING-D | роль из рунбука | Роль-владелец по триггеру: `{ "disk /data": "devops" }` называет роль, для которой открывается задача, поверх роли из рунбука. Роль должна существовать как каста компании; задача назначается агенту этой роли | Патч вливается в карту, поэтому владелец перенаправляется другой ролью, а не удалением ключа; чтобы вернуться к рунбуку, пришлите его роль. Роль без агента в компании оставляет задачу без исполнителя, и в теле задачи это сказано |