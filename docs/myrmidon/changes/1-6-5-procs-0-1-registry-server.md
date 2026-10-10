---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Board process registry, leader leases and the `general.processes` setting (PROCS-0.1)

The board now keeps a registry of its own OS processes. Migration `0388_board_processes`
adds two tables: `board_processes` (one row per running process: boot id, role, pid,
host, container, version, start and last-pulse time, API port, event loop lag, RSS) and
`board_leases` (named leader leases: holder boot id, epoch, acquisition and expiry
time). Each process writes its own row at boot and refreshes it every 10 seconds; rows
silent for more than 2 minutes are reaped by a process that owns background work. Two
read routes serve the «Процессы» panel: `GET /api/myrmidon/board-processes` (the rows
with age, status and the answering process marked) and
`GET /api/myrmidon/processes/leases` (the leases joined to their holder's row; an empty
list while nobody holds a lease). Both are for board members only.

The instance setting `general.processes` (`mode` single/split, `apiCount` 1..4,
`leaderLeaseTtlSec` 5..300, `liveEventsBus`, `admissionStore`, `singletonProxy`) is
stored and returned by the general settings API; absent means the defaults, which are
the single-process board. Nothing changes on a one-process board: it writes one registry
row and no leases. The setting is only stored for now — the supervisor that acts on
`split` lands in a later stage, so `split` has no effect yet.

## changelog-ru

### Реестр процессов доски, аренды лидера и настройка `general.processes` (PROCS-0.1)

Доска ведёт реестр собственных процессов ОС. Миграция `0388_board_processes` добавляет
две таблицы: `board_processes` (строка на каждый работающий процесс: boot id, роль, pid,
хост, контейнер, версия, время старта и последнего пульса, порт API, задержка цикла
событий, RSS) и `board_leases` (именованные аренды лидера: boot id держателя, эпоха,
время получения и истечения). Каждый процесс пишет свою строку при старте и обновляет её
раз в 10 секунд; строки, молчащие дольше 2 минут, удаляет процесс, владеющий фоновой
работой. Панель «Процессы» питают два маршрута чтения: `GET /api/myrmidon/board-processes`
(строки с возрастом, статусом и отметкой отвечающего процесса) и
`GET /api/myrmidon/processes/leases` (аренды вместе со строкой держателя; пустой список,
пока аренду никто не держит). Оба — только для членов доски.

Настройка инстанса `general.processes` (`mode` single/split, `apiCount` 1..4,
`leaderLeaseTtlSec` 5..300, `liveEventsBus`, `admissionStore`, `singletonProxy`)
сохраняется и отдаётся API общих настроек; нет значения — действуют умолчания, то есть
доска из одного процесса. На доске из одного процесса ничего не меняется: она пишет одну
строку реестра и ни одной аренды. Пока настройка только хранится: супервизор, который
исполняет `split`, придёт на следующем этапе, так что `split` пока ничего не меняет.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| --- | --- | --- | --- | --- | --- | --- |
| 1.6.5-PROCS-0.1-SERVER | Реестр процессов доски (`board_processes`) с пульсом раз в 10 с и удалением строк старше 2 мин, таблица аренд `board_leases`, маршруты чтения `/api/myrmidon/board-processes` и `/api/myrmidon/processes/leases`, ключ `general.processes` в общих настройках (по умолчанию — один процесс) | `packages/db/src/schema/index.ts`, `packages/shared/src/validators/instance.ts`, `packages/shared/src/types/instance.ts`, `server/src/services/instance-settings.ts`, `server/src/app.ts`, `server/src/index.ts` | Этап 0 проекта «несколько процессов доски» (design §5.1): без реестра нельзя ни проверить, жив ли владелец прогона, ни показать оператору, сколько процессов работает | `server/src/myrmidon/process-registry/*.myrmidon.test.ts`, `server/src/__tests__/instance-settings-processes.test.ts` | Реестр и аренды — аддитивные таблицы в собственных файлах; снять — убрать подключение в `app.ts` и `index.ts`, ключ в настройках и файлы реестра | см. PR |

## settings-en-append

<!-- section: Track 5 — operations -->
### Process registry: role and container name

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_PROCESS_CONTAINER` | PROCS-0.1 | unset | Container name written to the process registry row of this process (`board_processes.container`). Unset — the runtime's `HOSTNAME` (the container id under Docker) is used, and a bare host records none | Unset — `HOSTNAME`. Informational only: nothing reads it for decisions |

`PAPERCLIP_PROCESS_ROLE` (`all` / `worker` / `api`, default `all`) is the role this
process records in the registry; an unknown value means `all`, the single process. A
process with the `api` role does not reap stale registry rows.

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->
### Реестр процессов: роль и имя контейнера

| Переменная | Функция | Умолчание | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_PROCESS_CONTAINER` | PROCS-0.1 | не задана | Имя контейнера, которое процесс пишет в свою строку реестра (`board_processes.container`). Не задана — берётся `HOSTNAME` среды (под Docker это id контейнера), на голом хосте контейнер не записывается | Не задана — `HOSTNAME`. Только для показа: решения на ней не строятся |

`PAPERCLIP_PROCESS_ROLE` (`all` / `worker` / `api`, по умолчанию `all`) — роль, которую
процесс записывает в реестр; неизвестное значение означает `all`, то есть один процесс.
Процесс с ролью `api` устаревшие строки реестра не удаляет.
