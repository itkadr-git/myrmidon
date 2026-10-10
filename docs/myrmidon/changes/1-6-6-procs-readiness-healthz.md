## changelog-en

### PROCS-1.5: readiness of every process and the aggregate `/healthz` (ч.F)

- New `GET /internal/ready` on the app root: a process answers about itself,
  `200` when it can take traffic and `503` otherwise. The body names the role,
  the boot id, the `at` timestamp and the three cheap checks:
  `database` (one `SELECT 1` through the existing pool, with a 1 s deadline so
  a wedged connection cannot hold the request open), `migrations` (the in-memory
  boot phase of startup recovery, which only reaches `ready` after migrations
  ran) and `bus` (the subscription flag the bus wiring reports).
- New `GET /healthz` on the app root for the load balancer. With the process
  supervisor wired in (PROCS-1.2) it answers `200` only when **all N** api
  processes are ready and the supervisor's own checks pass — the supervisor is
  the process that applies migrations, so its state gates the switch to split.
  `startingSplit` is `503` by definition; the `single`, `emergencySingle` and
  `drainingToSingle` lanes answer with this process's own readiness, because in
  those lanes this process serves the board itself. Without a supervisor — in an
  api child, and on today's single process — the answer is this process alone
  and the body says `scope: "process"`.
- The aggregate body carries the counts an operator needs
  (`api: { desired, ready, starting }`), the supervisor state, the
  `reason` (`all_api_ready` / `api_not_ready` / `split_starting` /
  `process_ready` / `process_not_ready`) and the same check list as
  `/internal/ready`. Both endpoints set `Cache-Control: no-store`, read no
  credentials and expose no company data.
- The `bus` check is `not_applicable` — never blocking — until a process
  reports a subscription, so the check cannot report a healthy board as unready
  before a deployment that uses the bus exists. `bindProcessBusReadiness` wraps
  a bus so the flag turns on only after `start()` resolved and off before
  `stop()`.
- `createApp` takes an optional `processSupervisor` view; the split wiring of
  PROCS-1.2 passes it — or registers it once with `registerProcessSupervisor`,
  which the routes consult per request, because the split starts after the app
  is built. Default behaviour is unchanged: nothing new starts, and a
  process with no supervisor answers `/healthz` from its own checks.
- Unit tests cover the whole aggregate decision table (all lanes, the draining
  child, the N-th api still starting) and the route status codes and bodies of
  both endpoints. No process is spawned and no database is needed: the checks
  are injected, so the existing e2e harness of ч.C stays the only place that
  boots real processes.

## changelog-ru

### PROCS-1.5: готовность каждого процесса и агрегат `/healthz` (ч.F)

- Новый `GET /internal/ready` в корне приложения: процесс отвечает о себе —
  `200`, когда готов принимать, и `503` иначе. В теле роль, boot id, метка
  времени `at` и три дешёвые проверки: `database` (один `SELECT 1` через
  существующий пул, с дедлайном 1 с, чтобы зависшее соединение не держало
  запрос балансера), `migrations` (фаза загрузки в памяти, которая доходит до
  `ready` только после применения миграций) и `bus` (флаг подписки, который
  сообщает проводка шины).
- Новый `GET /healthz` в корне приложения для балансера. С подключённым
  супервизором процессов (PROCS-1.2) он отвечает `200` только когда готовы
  **все N** api-процессов и проходят собственные проверки супервизора —
  именно он применяет миграции, поэтому его состояние гейтит переход в split.
  `startingSplit` — это `503` по определению; полосы `single`,
  `emergencySingle` и `drainingToSingle` отвечают готовностью самого процесса,
  потому что в этих полосах доску обслуживает он. Без супервизора — в
  api-ребёнке и на сегодняшнем одиночном процессе — ответ описывает только
  этот процесс и в теле `scope: "process"`.
- В теле агрегата есть счётчики, нужные оператору
  (`api: { desired, ready, starting }`), состояние супервизора, `reason`
  (`all_api_ready` / `api_not_ready` / `split_starting` / `process_ready` /
  `process_not_ready`) и тот же список проверок, что у `/internal/ready`. Оба
  эндпоинта ставят `Cache-Control: no-store`, не читают учётных данных и не
  раскрывают данных компаний.
- Проверка `bus` остаётся `not_applicable` — то есть не блокирующей, — пока
  процесс не сообщил о подписке: так проверка не может объявить здоровую доску
  неготовой до появления развёртывания, которое эту шину использует.
  `bindProcessBusReadiness` оборачивает шину, чтобы флаг включался только после
  успешного `start()` и снимался перед `stop()`.
- `createApp` принимает необязательный вид супервизора `processSupervisor`; его
  передаёт проводка split из PROCS-1.2 — или один раз регистрирует через
  `registerProcessSupervisor`, который маршруты читают на каждом запросе,
  потому что split стартует после сборки приложения. Поведение по умолчанию не
  меняется: ничего нового не запускается, а процесс без супервизора отвечает
  `/healthz` по своим проверкам.
- Unit-тесты покрывают всю таблицу решений агрегата (все полосы, выводимый
  ребёнок, ещё не готовый N-й api) и коды с телами обоих эндпоинтов. Ни одного
  процесса не поднимается и база не нужна: проверки внедряются, поэтому
  существующий e2e-скелет ч.C остаётся единственным местом, где поднимаются
  настоящие процессы.