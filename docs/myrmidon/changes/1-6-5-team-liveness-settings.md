---
divergence-section: Трек 2 — ядро побудок и прогонов
settings-section: Track 2 — wake and run core
---

## changelog-en

### Team liveness settings on the instance and per agent (TEAM-LIVENESS-SETTINGS)

- The three automatic behaviours — AUTO-RESUME, RUN-STALL and IDLE-PICKUP —
  no longer read their `MYRMIDON_*` variables only at construction. Their knobs
  are now one settings area: stored in
  `instance_settings.general.teamLiveness`, resolved over the environment on
  every sweep pass, and changed on the Instance → General page ("Team liveness")
  or via `GET`/`PATCH /api/myrmidon/team-liveness`. A saved change takes effect
  on the next pass, with no restart and no run dropped in flight.
- Precedence is per key: a stored value wins, otherwise the environment
  variable, otherwise the built-in default. A key the operator never saved stays
  unsaved, so removing a variable later really takes effect; the settings page
  reports, per key, which of the three layers is in force.
- An agent card can switch a behaviour off for that one agent
  (`adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`,
  "Team liveness" on the card). The card carries no numbers: the company-wide
  wake ceiling and the wake throttle stay on the instance settings page, so no
  single agent can raise them.
- Every change is written to the activity log for every company
  (`instance.team_liveness.updated`), with the previous values and the changed
  keys.

## changelog-ru

### Настройки живости команды на инстансе и на агенте (TEAM-LIVENESS-SETTINGS)

- Три автоматических поведения — AUTO-RESUME, RUN-STALL и IDLE-PICKUP —
  больше не читают свои переменные `MYRMIDON_*` только при создании. Их ручки
  теперь одна область настроек: хранятся в
  `instance_settings.general.teamLiveness`, разбираются поверх окружения на
  каждом проходе подметания и меняются на странице Инстанс → Общие
  («Team liveness») или через `GET`/`PATCH /api/myrmidon/team-liveness`.
  Сохранённое изменение действует со следующего прохода, без перезапуска и без
  потери идущих прогонов.
- Приоритет по ключу: сохранённое значение, иначе переменная окружения, иначе
  встроенное умолчание. Ключ, который оператор не сохранял, остаётся
  несохранённым, поэтому удаление переменной позже действительно срабатывает;
  страница настроек показывает по каждому ключу, какой из трёх слоёв в силе.
- Карточка агента может выключить поведение для одного этого агента
  (`adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`,
  «Team liveness» на карточке). Карточка не несёт чисел: общий на компанию
  потолок побудок и их троттлинг остаются на странице настроек инстанса, чтобы
  один агент не мог их поднять.
- Каждое изменение пишется в журнал активности по каждой компании
  (`instance.team_liveness.updated`), с прежними значениями и списком
  изменённых ключей.
## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
|---|---|---|---|---|---|---|
| TEAM-LIVENESS-SETTINGS | Ручки трёх автоматических поведений (AUTO-RESUME, RUN-STALL, IDLE-PICKUP) становятся областью настроек: хранятся в `instance_settings.general.teamLiveness` (только те ключи, что оператор сохранил), разбираются поверх окружения на каждом проходе (порт `readLiveness` в трёх подметальщиках), меняются через `GET`/`PATCH /api/myrmidon/team-liveness` и панель «Team liveness» на странице Инстанс → Общие. Приоритет по ключу: сохранённое → переменная окружения → умолчание; источник каждого ключа отдаётся в ответе `sources`. Бюджет побудок получает разобранную пару через `IdleWakeBudget.configure`, поэтому оба пути IDLE-PICKUP считают по сохранённым числам, а не по значениям на момент старта. Карточка агента может выключить поведение для одного агента (`adapterConfig.teamLiveness`), чисел карточка не несёт | `server/src/services/heartbeat.ts` (читатель настроек, проброс в два подметальщика, гейт релизного пути, `configure` бюджета; метка `myrmidon(TEAM-LIVENESS-SETTINGS)`), `server/src/myrmidon/idle-pickup.ts`, `server/src/myrmidon/auto-resume.ts`, `server/src/myrmidon/run-stall/sweep.ts`, `server/src/myrmidon/run-stall/index.ts`, `server/src/services/instance-settings.ts` (проброс ключа через `normalizeGeneralSettings`), `packages/shared/src/validators/instance.ts` | Тикет OPE-3441 требует «настройки на инстансе и на агенте» для rescue-поведений, а до этого каждая ручка читалась только из окружения: смена значения = правка деплоя и перезапуск сервера, который роняет все идущие прогоны. Вендорский путь записи общих настроек молча выбрасывает ключ, которого нет в `normalizeGeneralSettings`, поэтому ключ проводится и там | `packages/shared/src/myrmidon-team-liveness.test.ts` (приоритет и источники по ключу, отказ негодной переменной, клампы, частичная сохранённая строка, трёхзначная карточка агента), `server/src/myrmidon/team-liveness/service.myrmidon.test.ts` (просмотр, запись только своих ключей, аудит по компаниям, отсутствие записи при пустом патче), `server/src/__tests__/idle-wake-budget.myrmidon.test.ts` (сохранённые числа побеждают окружение, выключенное поведение останавливает проход, карточка агента выключает побудку ему одному) | Никогда, наше поведение. Снятие: удалить блок `myrmidon(TEAM-LIVENESS-SETTINGS)` и `readLiveness` из трёх модулей, каталог `server/src/myrmidon/team-liveness/`, панель и поля карточки в UI, ключ `teamLiveness` из `validators/instance.ts` и `normalizeGeneralSettings`, оба тест-файла и фрагмент доков | (этот PR) |

## settings-en-new

### Team liveness settings (instance and agent card)

The three automatic behaviours read their knobs from one settings area. The
stored row lives in `instance_settings.general.teamLiveness`, holds only the
keys an operator saved, and is changed on the Instance → General page ("Team
liveness") or via `GET`/`PATCH /api/myrmidon/team-liveness`. Precedence is per
key: stored value, else the environment variable of the same knob (the table in
"Track 2 — wake and run core"), else the built-in default. The GET answers with
`sources` per key — `settings`, `env` or `default` — so a field the environment
does not actually control is never shown as "environment". The three sweeps
re-read the row on every pass: a saved change takes effect on the next pass
without a restart.

| Stored key | Behaviour | Default | What it does | Accepted values |
|---|---|---|---|---|
| `autoResumeEnabled` | AUTO-RESUME | `true` (on) | Master switch: the board resumes an agent left in `error` with backoff | boolean; absent follows `MYRMIDON_AUTO_RESUME_ENABLED` |
| `runStallEnabled` | RUN-STALL | `true` (on) | Master switch: a run that records no progress for the threshold is interrupted as stalled | boolean; absent follows `MYRMIDON_RUN_STALL_ENABLED` |
| `runStallThresholdSec` | RUN-STALL | `1200` (20 min) | Silence window after which a run counts as stalled (seconds) | 60..86400; a stored value outside the range is ignored and the environment/default applies |
| `idlePickupEnabled` | IDLE-PICKUP | `true` (on) | Master switch: the board wakes an idle agent whose ready task is assigned to it | boolean; absent follows `MYRMIDON_IDLE_PICKUP_ENABLED` |
| `idlePickupIntervalSec` | IDLE-PICKUP | `30` | How often (sec) the wake pass may look | at least 5; a smaller stored value is raised to 5 |
| `idlePickupWakeBudgetPerMin` | IDLE-PICKUP | `5` | Company-wide ceiling of automatic wakes per minute | 1..60; the budget object is re-configured from this value on every pass |
| `idlePickupWakeBatch` | IDLE-PICKUP | `5` | How many of that minute one pass may spend at once | 1..60, never above the minute ceiling |

Per agent, `adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`
("Team liveness" on the agent card) overrides one behaviour's switch for that
one agent: absent means "follow the instance settings". The card carries no
numbers — the company-wide ceiling and throttle stay on the instance settings
page.

Every change is written to the activity log for every company as
`instance.team_liveness.updated`, with the previous stored values and the
changed keys.

## settings-ru-new

### Настройки живости команды (инстанс и карточка агента)

Три автоматических поведения читают свои ручки из одной области настроек.
Сохранённая строка лежит в `instance_settings.general.teamLiveness`, содержит
только те ключи, что оператор сохранил, и меняется на странице Инстанс → Общие
(«Team liveness») или через `GET`/`PATCH /api/myrmidon/team-liveness`.
Приоритет по ключу: сохранённое значение, иначе переменная окружения той же
ручки (таблица в разделе «Трек 2 — ядро побудок и прогонов»), иначе встроенное
умолчание. Ответ GET содержит `sources` по каждому ключу — `settings`, `env`
или `default`, — поэтому поле, которым окружение на деле не управляет, никогда
не показывается как «окружение». Три подметальщика перечитывают строку каждый
проход: сохранённое изменение действует со следующего прохода, без перезапуска.

| Сохранённый ключ | Поведение | Умолчание | Что делает | Допустимые значения |
|---|---|---|---|---|
| `autoResumeEnabled` | AUTO-RESUME | `true` (вкл) | Полный выключатель: доска сама возобновляет агента, оставшегося в `error` | boolean; отсутствует — следует `MYRMIDON_AUTO_RESUME_ENABLED` |
| `runStallEnabled` | RUN-STALL | `true` (вкл) | Полный выключатель: прогон без записанного прогресса прерывается как `run_stalled` | boolean; отсутствует — следует `MYRMIDON_RUN_STALL_ENABLED` |
| `runStallThresholdSec` | RUN-STALL | `1200` (20 мин) | Окно тишины, после которого прогон считается зависшим (сек) | 60..86400; сохранённое значение вне диапазона игнорируется и работает окружение/умолчание |
| `idlePickupEnabled` | IDLE-PICKUP | `true` (вкл) | Полный выключатель: доска будит простаивающего агента, которому назначена готовая задача | boolean; отсутствует — следует `MYRMIDON_IDLE_PICKUP_ENABLED` |
| `idlePickupIntervalSec` | IDLE-PICKUP | `30` | Как часто (сек) проход побудок может смотреть | не меньше 5; меньшее сохранённое значение поднимается до 5 |
| `idlePickupWakeBudgetPerMin` | IDLE-PICKUP | `5` | Общий на компанию потолок автоматических побудок в минуту | 1..60; объект бюджета перенастраивается этим значением каждый проход |
| `idlePickupWakeBatch` | IDLE-PICKUP | `5` | Сколько из этой минуты один проход может потратить сразу | 1..60, никогда больше минутного потолка |

На агенте `adapterConfig.teamLiveness = { autoResume?, runStall?, idlePickup? }`
(«Team liveness» на карточке агента) переопределяет выключатель одного
поведения для этого одного агента: отсутствие ключа — «как на инстансе».
Чисел карточка не несёт: общий на компанию потолок и троттлинг остаются на
странице настроек инстанса.

Каждое изменение пишется в журнал активности по каждой компании как
`instance.team_liveness.updated`, с прежними сохранёнными значениями и списком
изменённых ключей.
