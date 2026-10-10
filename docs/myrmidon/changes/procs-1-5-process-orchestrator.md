---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### PROCS-T1.5: process-role orchestrator — the board launch map and config (api N + worker M)

- New `server/src/myrmidon/process-orchestrator/` — the single place the
  split board's launch map is computed. `config.ts` turns the env into a
  `ProcessMap` (design §2, §7.1): `single` mode returns exactly today's one
  `all` process with no overlays — byte-for-byte vendor behavior; `split`
  mode returns M worker entries + N api entries, workers first. Ports: api
  child i binds `PORT + i*MYRMIDON_API_PORT_STRIDE` (client entry stays
  `PORT`); worker i binds loopback `MYRMIDON_WORKER_PORT + i` (defaults to
  `PORT+4`, clear of the PROCS-1.1 single-worker slot 3101 the future
  proxy dials). Queues: the four execution-control sweeps split
  round-robin across workers (4/3/3/3 for M=1..4), each worker gets its
  slice written into its own `MYRMIDON_WORKER_QUEUES`; api entries own no
  queue. Every junk value is a hard `ProcessConfigError` before anything
  spawns — counts outside 1..4/1..2, ports outside 1024..65535, unknown
  queue names, an api/worker port-block collision, and the stride=0
  shared-port shape (which waits for PROCS-1.2's `reusePort`).
- New `launcher.ts` — the pure half of the spawner: `buildLaunchPlan`
  maps a `ProcessMap` to ordered spawn specs (`command`/`args`/`cwd`/`env`
  overlay/`healthUrl`), stamps every child with
  `PAPERCLIP_PARENT_BOOT_ID`, and spawns nothing itself. The env overlay
  carries the PROCS-1.1 role contract (`PAPERCLIP_PROCESS_ROLE`,
  `MYRMIDON_PROCESS_INDEX`) so a split child gates its background timers
  exactly as the role-gates PR specifies.
- New `scripts/procs-dev.ts` + `pnpm dev:procs` — the ticket's one-command
  dev stand: `MYRMIDON_API_PROCESSES=2 MYRMIDON_WORKER_PROCESSES=2 pnpm
  dev:procs` prints the launch card, prepares the same dists `pnpm dev`
  does (plugin sdk, ui), then spawns workers first and probes each child's
  `/api/health` before the next entry; Ctrl-C (or any child dying) stops
  the whole stand. No restart policy — that is PROCS-1.2. `--dry-run`
  prints the card only; a split without `DATABASE_URL` is refused with an
  explanation (embedded Postgres bootstraps one data dir per instance).
- `server/src/myrmidon/process-orchestrator/process-orchestrator.test.ts`
  pins all of it (17 tests): `single` stays a no-op card, the N=2+M=2
  acceptance map (ports 3100/3101 + 3104/3105, queue split 4/3, per-child
  role env), every error shape, and the plan mirroring the card.

## changelog-ru

### PROCS-T1.5: оркестратор ролей процессов доски — карта запуска и конфиг (api N + worker M)

- Новый `server/src/myrmidon/process-orchestrator/` — единственное место,
  где вычисляется карта запуска разделённой доски. `config.ts` превращает
  env в `ProcessMap` (дизайн §2, §7.1): режим `single` возвращает ровно
  сегодняшнего единственного процесса `all` без оверлеев — поведение
  вендора байт в байт; режим `split` возвращает M записей worker + N
  записей api, workers первыми. Порты: api-i слушает `PORT +
  i*MYRMIDON_API_PORT_STRIDE` (точка входа клиентов остаётся `PORT`);
  worker-i слушает loopback `MYRMIDON_WORKER_PORT + i` (по умолчанию
  `PORT+4`, не пересекая слот 3101 одиночного воркера из PROCS-1.1, куда
  впоследствии подключится прокси). Очереди: четыре sweep'а execution-control
  делятся между воркерами по кругу (4/3/3/3 при M=1..4), срез каждого
  воркера записан в его собственный `MYRMIDON_WORKER_QUEUES`; api не
  владеют ни одной очередью. Любое мусорное значение — жёсткий
  `ProcessConfigError` до запуска чего либо: счётчики вне 1..4/1..2,
  порты вне 1024..65535, неизвестные имена очередей, столкновение
  блоков api и worker, и stride=0 (общий порт ждёт `reusePort` из
  PROCS-1.2).
- Новый `launcher.ts` — чистая половина спавнера: `buildLaunchPlan`
  отображает `ProcessMap` в упорядоченные спеки запуска
  (`command`/`args`/`cwd`/оверлей env/`healthUrl`) и помечает каждого
  потомка `PAPERCLIP_PARENT_BOOT_ID`; сам ничего не запускает. Оверлей
  env несёт контракт ролей из PROCS-1.1 (`PAPERCLIP_PROCESS_ROLE`,
  `MYRMIDON_PROCESS_INDEX`), поэтому split-потомок gate'ит фоновые
  таймеры ровно как требует PR о ролях.
- Новый `scripts/procs-dev.ts` + `pnpm dev:procs` — стенд из критерия
  задачи одной командой: `MYRMIDON_API_PROCESSES=2
  MYRMIDON_WORKER_PROCESSES=2 pnpm dev:procs` печатает карту запуска,
  готовит те же дисты что `pnpm dev` (plugin sdk, ui), затем запускает
  воркеров первыми и ждёт `/api/health` каждого ребёнка перед следующим;
  Ctrl-C (или смерть любого ребёнка) останавливает весь стенд. Политики
  перезапуска нет — это PROCS-1.2. `--dry-run` печатает только карту;
  split без `DATABASE_URL` отклоняется с пояснением (embedded Postgres
  поднимает один каталог данных на инстанс).
- `server/src/myrmidon/process-orchestrator/process-orchestrator.test.ts`
  закрепляет всё (17 тестов): `single` остаётся пустой картой, карта
  приёмки N=2+M=2 (порты 3100/3101 + 3104/3105, делёж очередей 4/3,
  env ролей каждого ребёнка), каждая форма ошибки и зеркальность плана
  карте.

## divergence-new

<!-- after: 1.6.6 — PROCS-0.1: реестр процессов доски и панель «Процессы» -->
### 1.6.6 — PROCS-T1.5: оркестратор ролей процессов — карта запуска и конфиг

| PROCS-T1.5 | Карта запуска разделённой доски (N api + M worker): роли/порты/очереди из env, план спавна с health-пробами и собственный dev-раннер одной командой | `server/src/myrmidon/process-orchestrator/{config,launcher}.ts` (новое, чисто наше — вендорских файлов не трогает), `scripts/procs-dev.ts` + `package.json` (`dev:procs` — наша точка входа), `server/src/index.ts` (потомки читают роли через гейты PROCS-1.1, здесь изменений нет) | Этап 1.5 PROCS (дизайн OPE-5394 §2, §7.1): разделению нужны единая карта процессов и один источник правды для портов и очередей; у вендора карта не существует — единственный процесс | `server/src/myrmidon/process-orchestrator/process-orchestrator.test.ts` (single — no-op, карта N=2+M=2, ошибки конфига, зеркальность плана) | Никогда, наше поведение: при `PAPERCLIP_PROCESS_MODE` unset (`single`) ни один файл модуля в путь вендора не попадает. Когда вендор заведёт собственный мультипроцессный launcher — удалить модуль и `dev:procs`, перенести роли в его конфиг | (этот PR) |

## settings-en

| `MYRMIDON_API_PROCESSES` | PROCS-T1.5 | `1` (single mode ignores it; dev:procs default card asks `2`) | N api processes in `PAPERCLIP_PROCESS_MODE=split`: child i binds `PORT + i*MYRMIDON_API_PORT_STRIDE`, owns no queue, dials the worker block for the §7.1 proxy. Whole number 1..4 (design §7.2); junk or out of range aborts the launch | unset `PAPERCLIP_PROCESS_MODE` (or any value other than `split`) — single board as before |
| `MYRMIDON_WORKER_PROCESSES` | PROCS-T1.5 | `1` (single mode ignores it; dev:procs default card asks `2`) | M worker processes in split mode: worker i binds loopback `MYRMIDON_WORKER_PORT + i` and sweeps its round-robin slice (4/3/3/3) of the execution-control queues. Whole number 1..2 in stage 1 (design rule 3; M>1 warns, prod keeps M=1) | unset `PAPERCLIP_PROCESS_MODE` — all background work stays in the single `all` process |
| `MYRMIDON_API_PORT_STRIDE` | PROCS-T1.5 | `1` | Port step between api listeners (`PORT + i*stride`). Whole number 0..8; `0` (all api children share one port) is refused until PROCS-1.2 adds `reusePort`. Stride must also keep the api block clear of the worker block (collision = abort) | unset `PAPERCLIP_PROCESS_MODE`, or `=1` with `MYRMIDON_API_PROCESSES=1` — single listener as today |
| `MYRMIDON_WORKER_PORT` | PROCS-T1.5 | `PORT + 4` | First port of the worker loopback block (`127.0.0.1`): worker i listens on this + i. Chosen clear of the PROCS-1.1 single-worker slot `PORT+1` so the future §7.1 proxy dial has one stable base to move to | unset `PAPERCLIP_PROCESS_MODE` — workers bind nothing separate |
| `MYRMIDON_WORKER_HOST` | PROCS-T1.5 | `127.0.0.1` | Bind host and dial target of the worker block. Loopback-only by design: worker ports expose the full app (metrics), they are never a public surface | unset `PAPERCLIP_PROCESS_MODE` — no worker listener exists |
| `MYRMIDON_WORKER_QUEUES` | PROCS-T1.5 | unset = computed slice | Per-worker override of the execution-control queues it sweeps: comma list of `heartbeat,execctl_sweep,workspace_cleanup,worktree_cleanup` (what the child's env carries; the launcher writes the slice for worker i). Unknown names abort the launch | unset `PAPERCLIP_PROCESS_MODE` — the single `all` process sweeps every queue as today |
| `MYRMIDON_PROCESS_INDEX` | PROCS-T1.5 | set by the launcher | Index of this process inside its role block (`worker-i`/`api-i`) — stamped onto every split child so logs and the future registry rows name the exact slot | unset — single board has one process, no index needed |
| `PAPERCLIP_PARENT_BOOT_ID` | PROCS-T1.5 | set by the launcher | Boot id shared by every child of one launch (the launcher's own identity; the PROCS-1.2 supervisor name), written by `buildLaunchPlan` so a whole stand can be traced as one boot | unset — no orchestrator launched this process tree |

## settings-ru

| `MYRMIDON_API_PROCESSES` | PROCS-T1.5 | `1` (в single игнорируется; дефолтная карта dev:procs — `2`) | Сколько N api-процессов в `PAPERCLIP_PROCESS_MODE=split`: потомок i слушает `PORT + i*MYRMIDON_API_PORT_STRIDE`, очередей не владеет, обращается к блоку worker для прокси §7.1. Целое 1..4 (дизайн §7.2); мусор или вне диапазона — запуск прерван | не задан `PAPERCLIP_PROCESS_MODE` (или любое значение кроме `split`) — обычная монопроцессная доска |
| `MYRMIDON_WORKER_PROCESSES` | PROCS-T1.5 | `1` (в single игнорируется; дефолтная карта dev:procs — `2`) | Сколько M worker-процессов в split-режиме: worker i слушает loopback `MYRMIDON_WORKER_PORT + i` и выметает свой круговой срез (4/3/3/3) очередей execution-control. Целое 1..2 на этапе 1 (правило 3 дизайна; M>1 — предупреждение, в проде остаётся M=1) | не задан `PAPERCLIP_PROCESS_MODE` — вся фоновая работа в единственном процессе `all` |
| `MYRMIDON_API_PORT_STRIDE` | PROCS-T1.5 | `1` | Шаг портов слушателей api (`PORT + i*stride`). Целое 0..8; `0` (общий порт для всех api) отклонён до `reusePort` из PROCS-1.2. Шаг обязан держать блок api вне блока worker (столкновение = прерывание) | не задан `PAPERCLIP_PROCESS_MODE`, или `=1` при `MYRMIDON_API_PROCESSES=1` — один слушатель как сейчас |
| `MYRMIDON_WORKER_PORT` | PROCS-T1.5 | `PORT + 4` | Первый порт loopback-блока worker (`127.0.0.1`): worker i слушает этот + i. Выбран вдали от слота 3101 одиночного воркера из PROCS-1.1, чтобы будущий прокси §7.1 имел стабильную базу для перевода | не задан `PAPERCLIP_PROCESS_MODE` — отдельных слушателей у worker нет |
| `MYRMIDON_WORKER_HOST` | PROCS-T1.5 | `127.0.0.1` | Хост привязки и адрес обращений блока worker. Только loopback по дизайну: порты worker отдают полное приложение (метрики) и никогда не являются публичной поверхностью | не задан `PAPERCLIP_PROCESS_MODE` — слушателя worker нет |
| `MYRMIDON_WORKER_QUEUES` | PROCS-T1.5 | не задан = вычисленный срез | Ручная замена очередей execution-control для конкретного worker: список через запятую `heartbeat,execctl_sweep,workspace_cleanup,worktree_cleanup` (то, что несёт env потомка; launcher записывает срез worker i). Неизвестное имя — запуск прерван | не задан `PAPERCLIP_PROCESS_MODE` — единственный процесс `all` выметает все очереди как сейчас |
| `MYRMIDON_PROCESS_INDEX` | PROCS-T1.5 | задаётся лончером | Индекс процесса внутри его роли (`worker-i`/`api-i`) — проставляется каждому split-потомку, чтобы логи и будущие строки реестра называли точный слот | не задан — у монопроцессной доски индекса нет |
| `PAPERCLIP_PARENT_BOOT_ID` | PROCS-T1.5 | задаётся лончером | Boot id, общий у всех потомков одного запуска (идентичность лончера; имя из PROCS-1.2), проставляется `buildLaunchPlan` — весь стенд трассируется как один запуск | не задан — это дерево процессов запускал не оркестратор |
