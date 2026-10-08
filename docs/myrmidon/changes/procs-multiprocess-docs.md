---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Multi-process board mode (BOARD-PROCESSES): operator documentation

The board can run as several Node processes in one container: one worker holds
the loops and singleton state, and N api children (1..4) serve HTTP with
`reusePort`. The mode is set in the interface at Instance settings → «Процессы»
and applies without a restart. The default stays `single` (one process does
everything) — nothing changes unless the operator explicitly switches to
`split`. An emergency fallback `PAPERCLIP_PROCESS_MODE=single` forces the
one-process mode on boot, bypassing the database. Documentation of the mode,
its settings, ports, and dockergate implications is in deploy.md, SETTINGS.md,
and dockergate.md.

## changelog-ru

### Многопроцессный режим доски (BOARD-PROCESSES): документация оператора

Доска может работать в нескольких процессах Node внутри одного контейнера:
один worker держит циклы и одиночное состояние, а N api-детей (1..4) обслуживают
HTTP с `reusePort`. Режим задаётся в интерфейсе: настройки инстанса → «Процессы»,
и применяется без перезапуска. По умолчанию остаётся `single` (один процесс делает
всё) — ничего не меняется, пока оператор явно не переключит в `split`. Аварийный
путь `PAPERCLIP_PROCESS_MODE=single` принудительно включает однопроцессный режим
при загрузке, в обход базы. Документация режима, его настроек, портов и следствий
для dockergate — в deploy.md, SETTINGS.md и dockergate.md.

## divergence

| PROCS-DOCS | Docs describe the target behavior of BOARD-PROCESSES (supervisor of api children, leader lease, `general.processes`, ports, `PAPERCLIP_PROCESS_MODE`) ahead of the code landing it | docs/myrmidon/deploy.md, SETTINGS.md, dockergate.md (+ru) | Owner decision: docs ship ahead of code; the multiprocess parts are merged by stages under BOARD-PROCESSES | docs review at 1.6.6 freeze | Remove the divergence once the mode is fully implemented and matches the docs | this PR |

## settings-en-append

<!-- section: Track 5 — operations -->
### Multi-process mode (BOARD-PROCESSES): the `general.processes` instance setting

The split of the board into a worker process and N api processes is driven by one
instance-settings key, edited in the interface at Instance settings → **«Процессы»** —
not by environment variables. It writes `instance_settings.general.processes`:

| Field | Values | Default | What it does |
|---|---|---|---|
| `mode` | `single` / `split` | `single` | `single` — one process does everything (today's behavior, unchanged). `split` — one worker plus `apiCount` api children |
| `apiCount` | 1..4 | 1 | How many api children the worker forks in `split`. The practical ceiling is 3 (see [deploy.md](deploy.md#multi-process-mode-board-processes)) |
| `leaderLeaseTtlSec` | seconds | 30 | TTL of the leader lease; it is renewed every TTL/3 |
| `liveEventsBus` | `local` / `pg` | `local` | How live events travel between processes: `local` — in-process only; `pg` — also over Postgres `LISTEN/NOTIFY` |
| `admissionStore` | `memory` / `db` | `memory` | Where run-admission counters live: `memory` — in the executor process; `db` — derived from `heartbeat_runs` under one advisory lock |
| `singletonProxy` | bool | `true` | Whether api children proxy the singleton routes (attention feed, bot container, plugins, workspace runtime, hot-restart) to the worker over loopback |

The defaults are exactly the single-process behavior: nothing changes until `mode` is
switched to `split`. Every change applies **without a restart** — the writing process
publishes `settings_changed` and each process (including the writer) applies the new
value through the applier registry; the supervisor in the worker reconciles the desired
`apiCount` with the live children (fork new ones up, `drain` one down).

The feature adds **no new environment variables** except one emergency override:

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `PAPERCLIP_PROCESS_MODE` | BOARD-PROCESSES | unset | Emergency override read **before** the database: `single` forces the one-process mode on boot when a stored settings value broke the start. Not a configuration path — the switch belongs in the interface | Unset — the stored `general.processes.mode` applies. `single` — force one process |

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->
### Многопроцессный режим (BOARD-PROCESSES): настройка инстанса `general.processes`

Разделение доски на процесс worker и N процессов api управляется одним ключом
настроек инстанса, правится в интерфейсе: настройки инстанса → **«Процессы»**, — а не
переменными окружения. Ключ пишет `instance_settings.general.processes`:

| Поле | Значения | По умолчанию | Что делает |
|---|---|---|---|
| `mode` | `single` / `split` | `single` | `single` — один процесс делает всё (сегодняшнее поведение, без изменений). `split` — один worker плюс `apiCount` детей api |
| `apiCount` | 1..4 | 1 | Сколько api-детей форкает worker в режиме `split`. Фактический потолок — 3 (см. [deploy.ru.md](deploy.ru.md#многопроцессный-режим-board-processes)) |
| `leaderLeaseTtlSec` | секунды | 30 | TTL аренды лидера; обновляется каждые TTL/3 |
| `liveEventsBus` | `local` / `pg` | `local` | Как живые события идут между процессами: `local` — только внутри процесса; `pg` — также через `LISTEN/NOTIFY` Postgres |
| `admissionStore` | `memory` / `db` | `memory` | Где живут счётчики допуска прогонов: `memory` — в процессе исполнителя; `db` — выводятся из `heartbeat_runs` под одним advisory lock |
| `singletonProxy` | bool | `true` | Проксируют ли api-дети одиночные маршруты (лента внимания, контейнер ботов, плагины, рантайм воркспейса, горячий рестарт) в worker по loopback |

Дефолты — в точности поведение одного процесса: ничего не меняется, пока `mode` не
переключён в `split`. Каждое изменение применяется **без перезапуска** — записавший
процесс публикует `settings_changed`, и каждый процесс (включая записавший) применяет
новое значение через реестр применителей; супервизор в worker сводит желаемый
`apiCount` с живыми детьми (форк новых вверх, `drain` одного вниз).

Фича не добавляет новых переменных окружения, кроме одного аварийного переопределения:

| Переменная | Функция | По умолчанию | Что делает | Как выключить / особое |
|---|---|---|---|---|
| `PAPERCLIP_PROCESS_MODE` | BOARD-PROCESSES | не задан | Аварийное переопределение, читаемое **раньше базы данных**: `single` принудительно включает однопроцессный режим при загрузке, если записанное значение настройки сломало старт. Не путь настройки — переключатель живёт в интерфейсе | Не задана — действует записанный `general.processes.mode`. `single` — принудительно один процесс |
