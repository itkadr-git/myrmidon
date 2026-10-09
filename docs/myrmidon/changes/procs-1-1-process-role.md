---
divergence-section: Трек 2 — ядро побудок и прогонов
---

## changelog-en

### 1.6.6 — BOARD-PROCESSES part A: the process role and the background-work gates (PROCS-1.1)

- The board can now be started as one process (`all`, the default and today's
  behaviour) or split between a scheduler process (`worker`) and HTTP-only
  processes (`api`): `PAPERCLIP_PROCESS_ROLE=api` starts without a single
  background timer — no heartbeat scheduler, no reconciliation sweeps, no
  plugin workers, no backups — serves the board on `0.0.0.0:3100` with
  `reusePort` so several api processes share the port, and waits for the
  migration-owning process instead of migrating the database itself. The
  `worker` process runs every timer and additionally serves the board app on
  the internal loopback `127.0.0.1:3101`.
- Every gate on background work reads one place — `processRole()` in
  `server/src/services/process-role.ts` (env `PAPERCLIP_PROCESS_ROLE` in
  `all|worker|api`) — instead of a scattering of `if` checks; `all` is
  byte-for-byte today's behaviour, and an unknown value falls back to `all`
  with a warning at startup.

## changelog-ru

### 1.6.6 — BOARD-PROCESSES, часть A: роль процесса и гейты фоновой работы (PROCS-1.1)

- Доску теперь можно запускать одним процессом (`all` — умолчание и сегодняшнее
  поведение) или разделить работу между процессом-планировщиком (`worker`) и
  процессами только-HTTP (`api`): `PAPERCLIP_PROCESS_ROLE=api` стартует без
  единого фонового таймера — без цикла планировщика побудок, без сверок
  исполнения, без воркеров плагинов и без дампов БД — отдаёт доску на
  `0.0.0.0:3100` с `reusePort` (несколько api-процессов делят порт) и ждёт
  migrations_applied от процесса-владельца миграций, не мигрируя базу сам.
  Процесс `worker` ведёт все таймеры и дополнительно отдаёт приложение доски на
  внутреннем loopback `127.0.0.1:3101`.
- Все гейты фоновой работы читают одну точку — `processRole()` в
  `server/src/services/process-role.ts` (env `PAPERCLIP_PROCESS_ROLE` in
  `all|worker|api`) — вместо десятка `if` по коду; `all` ведёт себя как сегодня
  побайтово, а неизвестное значение откатывается к `all` с предупреждением в
  журнале при старте.

## divergence

| PROCS-1.1 | Роль процесса и гейты фоновой работы: одна точка `processRole()` (env `PAPERCLIP_PROCESS_ROLE` in `all\|worker\|api`, умолчание `all`; неизвестное значение — откат к `all` с предупреждением при старте) решает, что этому процессу разрешено: `runsBackground` (все периодические таймеры, подметальщики и воркеры плагинов), `executesRuns` (какие побудки и прогоны вообще поднимаются в этом процессе), `migrations` (`apply` у worker/all, `await` у api — процесс `api` дожидается `migrations_applied` и не мигрирует базу сам), `runsBackups` (дампы БД), `listen` (api — `0.0.0.0:3100` с `reusePort`, чтобы N процессов делили порт; all/worker — сконфигурированный `host:port` как сегодня) и `loopbackListen` (worker — внутренний `127.0.0.1:3101`). Гейты стоят на конструировании и запуске планировщика побудок, интервале сверки исполнения и его стартовом проходе, догоне дампов БД, примонтированной к `createApp` опции `backgroundWork` (воркеры плагинов, экспорт отзывов, каналы почты, сверка чатов, подметание спул импорта, восстановление застрявших прогонов), а также на операциях `start*` Myrmidon и авто-возобновлении (`scheduleAutoResumeSweep`) — они живут в ветке фоновой роли. `all` — сегодняшнее поведение побайтово | `server/src/index.ts` (метки `myrmidon(PROCS-1.1)`: импорт роли, предупреждение о неизвестном значении, гейт миграций и ожидание `migrations_applied`, конструирование планировщика, интервалы и стартовые проходы, дампы, роль-управляемый `listen`, loopback-слушатель worker, shutdown), `server/src/app.ts` (опция `backgroundWork` и `backgroundWorkEnabled`, гейты фоновых свипов и воркеров) + `server/src/services/process-role.ts` | T1.1 документа OPE-5394 (этап 1 BOARD-PROCESSES): несколько процессов доски — роли `api` (N) и планировщик-лидер; чтобы вынести HTTP-поверхность в отдельные процессы, фоновая работа должна иметь одну точку переключения, а не разбросанные `if` по коду. Вендорского разделения ролей нет | `server/src/services/process-role.myrmidon.test.ts` (матрица ролей: `api` не запускает ни одного фонового таймера — тест перечисляет их, `all`/`worker` запускают все, неизвестное значение откатывается к `all`, адреса слушателей и `executesRuns`), `server/src/__tests__/server-startup-roles.myrmidon.test.ts` (в нём — точка переключения в `index.ts`) | Никогда, наше поведение. Когда вендор сам разделит процессы доски на роли: удалить метки `myrmidon(PROCS-1.1)`, модуль роли и тесты, вернуть вендорские ветки запуска | (этот PR) |
| PROCS-1.1-B | Ключ настроек экземпляра `instance_settings.general.processes`: сколько процессов доски и что каждому разрешено (умолчание `single` — один процесс, как сегодня; `split` сохранён, но ещё не действует, поэтому интерфейс честно показывает действующий режим и причину). Хранит `mode`, `apiCount`, `leaderLeaseTtlSec`, `liveEventsBus`, `admissionStore`, `singletonProxy`; значения читаются из строки настроек, перекрываются env (`PAPERCLIP_PROCESS_MODE`) и, если не заданы нигде, берутся умолчания. Маршруты `GET`/`PATCH /api/myrmidon/processes` (чтение — участник доски с доступом к экземпляру, запись — instance-admin, как у остальных настроек экземпляра) отдают каждое значение с источником (`settings`/`env`/`default`) и режим, действующий в этом процессе; запись пишет строку настроек, по строке журнала активности на каждую компанию (`myrmidon.processes.updated`, что изменено) и применяет значение к живому процессу без перезапуска. Секция «Processes of the board» на странице Instance → General | `server/src/app.ts` (монтирование маршрута с меткой `myrmidon(PROCS-1.1)`), `server/src/services/instance-settings.ts` (перенос `processes` в нормализацию настроек), `packages/shared/src/index.ts` (экспорт), `packages/shared/src/types/instance.ts` (поле в интерфейсе настроек), `packages/shared/src/validators/instance.ts` (поле в валидаторе), `server/src/index.ts` (стартовое чтение до создания приложения), `ui/src/pages/InstanceGeneralSettings.tsx` (монтирование секции) + `packages/shared/src/myrmidon-processes.ts`, `server/src/myrmidon/processes/{service,routes,index}.ts`, `ui/src/components/myrmidon/{ProcessesSettingsPanel.tsx,processesApi.ts}` | T1.1 документа OPE-5394 (ключ `processes` с дефолтом `single|all`): число процессов доски и роль каждого должны меняться из интерфейса доски, без перезапуска и правки env. Вендорского ключа настроек для числа процессов нет | `packages/shared/src/myrmidon-processes.test.ts` (умолчания, источник каждого значения, синхронность поля в интерфейсе настроек и валидаторе, отказ валидации на неизвестный ключ и значение), `server/src/myrmidon/processes/processes.myrmidon.test.ts` (чтение/источники, запись → аудит по компаниям → применение к живому процессу, права и валидация, сохранённый `split` не выдаётся за действующий режим), `ui/src/components/myrmidon/ProcessesSettingsPanel.myrmidon.test.tsx` (панель: действующий режим, предупреждение о сохранённом `split`, сохранение на лету) | Никогда, наше поведение. При переносе сохранить монтирование маршрута и стартовое чтение; если вендор заведёт собственный набор процессов и ролей — удалить маршрут, модуль настроек, поле настроек и секцию UI | (этот PR) |

## settings-en-new

<!-- after: 1.6.4 — AUTONOMY-DELETE: matrix enforcement tests and route mapping -->
### 1.6.6 — PROCS-1.1: the processes of the board

How many board processes exist and what each of them is allowed to do. The
default is one process that does everything — today's behaviour, byte-for-byte
— and it needs no setting at all. Splitting the board into a scheduler process
and HTTP-only processes is configured from the board interface (Instance →
General → *Processes of the board*) and takes effect without a restart: the
values live in `instance_settings.general.processes` (the contract and defaults
are defined in `packages/shared/src/myrmidon-processes.ts`).

The **process role** itself is per-process and therefore an environment
variable: one deployment's api processes and its worker are told apart at
startup, so a role cannot come from a shared settings row.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `PAPERCLIP_PROCESS_ROLE` | PROCS-1.1 | `all` | The role of this process: `all` — one process does everything (HTTP on the configured bind plus every background timer); `worker` — the scheduler: every background timer, run execution, migrations, the database backups and the internal loopback listener on `127.0.0.1:3101`; `api` — HTTP only, no background timers, no run execution, no plugin workers, no backups, serves the board on `0.0.0.0:3100` with `reusePort` and waits for `migrations_applied` instead of migrating the database | Unset (`all`) restores the single-process board. An unrecognized value never invents a role: the process starts as `all` and the fallback is logged as a warning at startup |
| `PAPERCLIP_PROCESS_MODE` | PROCS-1.1 | unset | Overrides the stored `processes.mode` for this process group: `single` (one process — matches `PAPERCLIP_PROCESS_ROLE=all`) or `split` | Unset means the stored setting (which itself defaults to `single`) applies |
| `general.processes` (settings area) | PROCS-1.1 | `mode: single`, `apiCount: 1`, `leaderLeaseTtlSec: 30`, `liveEventsBus: database`, `admissionStore: database`, `singletonProxy: true` | The board's process settings, editable on the settings page (Instance → General → *Processes of the board*) and applied without a restart: `mode` — one process or a split; `apiCount` — how many HTTP processes share the port (1–16); `leaderLeaseTtlSec` — the leader lease of the later parts (10–600 s); `liveEventsBus` / `admissionStore` — `database` (shared, today) or `local` (in-process, faster but per-process); `singletonProxy` — keep exactly one proxy writer while several processes write the same resources | `mode: single` is what the board runs today and needs nothing else. `split` is stored and reported, but the supervisor that acts on it arrives in a later part of the feature: the page says so instead of pretending the mode is in force. Reading is the board's to inspect, writing is an instance admin's |

## settings-ru-new

<!-- after: 1.6.3 — PROMPT-BUDGET C: рекомендации по оптимизации промпта и глубокий разбор -->
### 1.6.6 — PROCS-1.1: процессы доски

Сколько процессов доски существует и что каждому из них разрешено. Умолчание —
один процесс, который делает всё: сегодняшнее поведение, побайтово, и ему не
нужна никакая настройка. Разделение доски на процесс-планировщик и процессы
только-HTTP настраивается из интерфейса доски (Instance → General → *Processes
of the board*) и действует без перезапуска: значения живут в
`instance_settings.general.processes` (контракт и умолчания определены в
`packages/shared/src/myrmidon-processes.ts`).

Сама **роль процесса** задаётся переменной окружения: api-процессы и worker
одной установки различаются на старте, поэтому роль не может приезжать из общей
строки настроек.

| Переменная | Функция | Умолчание | Что делает | Как выключить / особенность |
|---|---|---|---|---|
| `PAPERCLIP_PROCESS_ROLE` | PROCS-1.1 | `all` | Роль этого процесса: `all` — один процесс делает всё (HTTP на сконфигурированном адресе плюс все фоновые таймеры); `worker` — планировщик: все фоновые таймеры, исполнение прогонов, миграции, дампы БД и внутренний loopback-слушатель `127.0.0.1:3101`; `api` — только HTTP: без фоновых таймеров, без исполнения прогонов, без воркеров плагинов, без дампов, отдаёт доску на `0.0.0.0:3100` с `reusePort` и ждёт `migrations_applied`, не мигрируя базу сам | Не задавать (`all`) — вернуть однопроцессную доску. Неизвестное значение не выдумывает роль: процесс стартует как `all`, откат пишется предупреждением в журнал при старте |
| `PAPERCLIP_PROCESS_MODE` | PROCS-1.1 | не задано | Перекрывает сохранённый `processes.mode` для этой группы процессов: `single` (один процесс — соответствует `PAPERCLIP_PROCESS_ROLE=all`) или `split` | Не задано — действует сохранённая настройка (она сама по умолчанию `single`) |
| `general.processes` (область настроек) | PROCS-1.1 | `mode: single`, `apiCount: 1`, `leaderLeaseTtlSec: 30`, `liveEventsBus: database`, `admissionStore: database`, `singletonProxy: true` | Настройки процессов доски, меняются на странице настроек (Instance → General → *Processes of the board*) и применяются без перезапуска: `mode` — один процесс или разделение; `apiCount` — сколько HTTP-процессов делят порт (1–16); `leaderLeaseTtlSec` — аренда лидера из следующих частей (10–600 с); `liveEventsBus` / `admissionStore` — `database` (общая, как сегодня) или `local` (в процессе, быстрее, но у каждого процесса своя); `singletonProxy` — держать ровно одного писателя прокси, пока несколько процессов пишут в одни ресурсы | `mode: single` — то, что доска запускает сегодня, и больше ничего не нужно. `split` сохраняется и показывается, но супервизор, который его исполняет, приедет следующей частью функции: страница говорит об этом прямо, а не делает вид, что режим действует. Чтение доступно участнику доски, запись — администратору экземпляра |