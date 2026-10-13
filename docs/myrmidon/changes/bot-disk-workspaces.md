---
divergence-section: 1.6.1 — BOT-DISK A: жизненный цикл черновиков бота
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en

### Bot task workspaces are owned by the board: `myr-ws`, worktrees off a per-bot base, removal on task lifecycle events (1.6.5 BOT-DISK-H, parts H1–H5, contract H0)

- A task's working copy is now a **git worktree** of a per-bot bare base
  (`<HERMES_HOME>/.myrmidon/git-base/<owner>/<repo>.git`, standard refspec
  `+refs/heads/*:refs/remotes/origin/*`, `fetch.prune=true`, `gc.auto=0`), not a
  clone the bot made itself: no per-copy objects, no `--filter` promisor packs,
  no token in `.git/config`. The base limit is 8 repositories per bot
  (`WS_GIT_BASE_LIMIT`), a base fetch is throttled to one per 900 s
  (`WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC`).
- New in-image CLI `myr-ws`: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
  `list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`.
  `open` is idempotent (`reused: true` for an existing copy). Task copies live at
  `/workspace/<ISSUE-KEY>` on branch `bot/<KEY>`; scratch copies (class G) at
  `/scratch/<name>`.
- The git wrapper no longer adds `--reference`: a `git clone` of a GitHub
  repository is intercepted into `myr-ws open` (the task key comes from
  `MYRMIDON_TASK_WORKSPACE`, otherwise the clone becomes a scratch copy);
  `--filter`/`--depth`/`--mirror`/`--bare` are ignored with a message — the
  objects are already in the base. The real git moves to
  `/opt/paperclip/libexec/git` outside PATH; the credential helper stays the
  only source of auth, so a token never lands in a repository config.
- The board, not a timer, drives removal: the in-container agent `botd` fetches
  the desired state `GET /api/myrmidon/bots/me/workspaces` (`state:
  active|closing` per copy, grace `closingMinutes` 30, `scratchTtlHours` 24) and
  removes the worktree when the task turns terminal / is reassigned / its PR
  merges. A copy with unpushed work is **archived first** (branch bundle +
  patch + untracked files under `archive/<KEY>-<ts>.*` with a manifest, cap 2
  GiB and 30 days per bot) and can be brought back with `myr-ws restore <KEY>`.
  When the board is unreachable botd is fail-safe: it deletes nothing.
- Refusals are explicit, with stable exit codes parsed by the gateway:
  `3` quota/disk — the message starts with `BOT_DISK_QUOTA_EXCEEDED:` —
  `4` repository over the base limit, `5` network/fetch, `6` no such
  copy/archive, `7` unpushed work without `--force`. A run whose `workspace`
  field cannot be opened (codes 3/4/5) still starts, in `/scratch`
  (`RUN_WORKSPACE_FALLBACK_DIR`), with a warning event — never a silent
  failure.
- Observability: botd posts `POST /api/myrmidon/bots/me/disk-report`
  (bases, copies with clean/pushed flags and sizes, archives, actions, foreign
  copies with their sign; body ≤ 1 MiB, at most 200 actions) and the answer
  sets its next tick (`nextReportSec`). Attention cards:
  `bot_disk_lifecycle/agent-silent` (report older than 30 min),
  `bot_disk_lifecycle/drift`, `bot_disk_lifecycle/foreign`,
  `bot_disk_lifecycle/ws-cli`, `bot_disk_lifecycle/reflink`,
  `bot_image_stale`, `bot_disk_archive`.
- New instance settings under `general.botDisk.*`: `graceClosingMinutes` (30),
  `scratchTtlHours` (24), `partitionThresholdPercent` (85),
  `partitionRefuseOpenPercent` (90), `partitionCriticalPercent` (95),
  `pnpmStoreDir`, `pnpmImportMethod`; the per-bot quota setting is the existing
  `general.botDiskQuota`. See SETTINGS for the full table.
- Interface contract H0 (directory layout, CLI, desired state, disk report,
  dockergate routes, `/v1/runs` field, settings) is fixed in
  `docs/myrmidon/bot-disk-contract/README.md` with JSON fixtures that validate
  against the Zod schemas in `packages/shared/src/myrmidon-bot-workspace.ts`
  (PR #702). This change documents and implements against that contract;
  neighboring parts land as their own PRs.

## changelog-ru

### Рабочие копии задач ботов принадлежат доске: `myr-ws`, worktree от базы на бота, удаление по событиям задачи (1.6.5 BOT-DISK-H, части H1–H5, контракт H0)

- Рабочая копия задачи — теперь **worktree** голой базы бота
  (`<HERMES_HOME>/.myrmidon/git-base/<owner>/<repo>.git`, стандартный refspec
  `+refs/heads/*:refs/remotes/origin/*`, `fetch.prune=true`, `gc.auto=0`), а не
  клон, который бот завёл сам: ни своих объектов у копии, ни promisor-паков от
  `--filter`, ни токена в `.git/config`. Лимит баз — 8 репозиториев на бота
  (`WS_GIT_BASE_LIMIT`), обновление базы — не чаще раза в 900 с
  (`WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC`).
- Новый CLI образа `myr-ws`: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
  `list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; общий флаг
  `--json`. `open` идемпотентен (`reused: true` для существующей копии). Копии
  задач живут в `/workspace/<ISSUE-KEY>` на ветке `bot/<KEY>`; scratch-копии
  (класс G) — в `/scratch/<name>`.
- Обёртка git меняет роль: `git clone` репозитория GitHub перехватывается в
  `myr-ws open` (ключ задачи берётся из `MYRMIDON_TASK_WORKSPACE`, иначе клон
  становится scratch-копией); флаги `--filter`/`--depth`/`--mirror`/`--bare`
  игнорируются с сообщением — объекты уже есть в базе. Настоящий git переезжает
  в `/opt/paperclip/libexec/git` вне PATH; единственный источник учётных данных
  остаётся credential helper, поэтому токен не попадает в конфиг репозитория.
- Удалением рулит доска, а не таймер: агент в контейнере `botd` получает
  желаемое состояние `GET /api/myrmidon/bots/me/workspaces` (`state:
  active|closing` на копию, grace `closingMinutes` 30, `scratchTtlHours` 24) и
  убирает worktree, когда задача стала терминальной / переназначена / её PR
  слит. Копия с незапушенной работой сначала **архивируется** (bundle веток +
  patch + неотслеживаемые файлы в `archive/<KEY>-<ts>.*` с манифестом, потолок
  2 ГиБ и 30 суток на бота) и восстанавливается командой `myr-ws restore
  <KEY>`. Когда доска недоступна, botd не удаляет ничего (fail-safe).
- Отказы явные, со стабильными кодами выхода, которые парсятся гейтвеем:
  `3` — квота/диск, сообщение начинается с `BOT_DISK_QUOTA_EXCEEDED:`,
  `4` — репозиторий сверх лимита баз, `5` — сеть/fetch, `6` — нет такой
  копии/архива, `7` — незапушенная работа без `--force`. Прогон, чьё поле
  `workspace` не удалось открыть (коды 3/4/5), всё равно стартует — в
  `/scratch` (`RUN_WORKSPACE_FALLBACK_DIR`), с предупреждением в событиях,
  а не молча падает.
- Наблюдаемость: botd отправляет `POST /api/myrmidon/bots/me/disk-report`
  (базы, копии с флагами clean/pushed и размерами, архивы, действия, чужие
  копии с признаком; тело ≤ 1 МиБ, не больше 200 действий), ответ задаёт темп
  следующего прохода (`nextReportSec`). Карточки внимания:
  `bot_disk_lifecycle/agent-silent` (отчёту больше 30 минут),
  `bot_disk_lifecycle/drift`, `bot_disk_lifecycle/foreign`,
  `bot_disk_lifecycle/ws-cli`, `bot_disk_lifecycle/reflink`,
  `bot_image_stale`, `bot_disk_archive`.
- Новые настройки экземпляра в `general.botDisk.*`: `graceClosingMinutes` (30),
  `scratchTtlHours` (24), `partitionThresholdPercent` (85),
  `partitionRefuseOpenPercent` (90), `partitionCriticalPercent` (95),
  `pnpmStoreDir`, `pnpmImportMethod`; квота на бота — уже существующая
  настройка `general.botDiskQuota`. Полная таблица — в SETTINGS.
- Интерфейсный контракт H0 (раскладка каталогов, CLI, желаемое состояние,
  отчёт о диске, маршруты dockergate, поле `/v1/runs`, настройки) зафиксирован
  в `docs/myrmidon/bot-disk-contract/README.md` с JSON-фикстурами, которые
  проходят Zod-схемы `packages/shared/src/myrmidon-bot-workspace.ts`
  (PR #702). Это изменение документирует и реализует строго этот контракт;
  соседние части эпика приходят своими PR.

## settings-en

| `general.botDisk.graceClosingMinutes` | 1.6.5-BOT-DISK-H | `30` | Grace period (minutes) between a task turning `closing` in the desired state (terminal / reassigned / PR merged) and botd removing its worktree; while the partition pressure is `hard` (quota ≥ 100 %) the effective grace is 0 | From 5 to 1440; unset or out of range — the default. Changed on Instance → General (`PATCH /api/myrmidon/bot-disk`), botd picks it up with the next desired-state fetch, no restart |
| `general.botDisk.scratchTtlHours` | 1.6.5-BOT-DISK-H | `24` | Idle TTL (hours, by mtime/ctime) of a scratch copy (class G): past it botd archives it if it holds unpushed commits, then removes it — the one place a timer is legitimate | From 1 to 720; unset or out of range — the default. Under hard partition pressure the effective TTL is 1 hour |
| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H | `85` | Fill level of the bot partition (physical, from dockergate `GET /myrmidon/disk`) at which the instance card `host_disk_alert` is raised with the partition's figures | From 50 to 100; unset or out of range — the default |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H | `90` | Fill level of the bot partition at which `myr-ws open` refuses **every** bot with `BOT_DISK_QUOTA_EXCEEDED:` (exit 3) and every botd runs with grace 0 | From 50 to 100; must be ≥ `partitionThresholdPercent`; unset or out of range — the default |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H | `95` | Fill level of the bot partition at which the critical instance card is raised and the owner gets a Telegram signal | From 50 to 100; must be ≥ `partitionRefuseOpenPercent`; unset or out of range — the default |
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H | unset (per-bot store in the workspace mount) | Directory of the shared pnpm store; per contract it must sit **on the bot partition** (one store per partition), so a reflink import from it into the bot volumes works (reflink does not cross filesystems) | Unset — previous behaviour. When set, pair it with `pnpmImportMethod: clone` and a working reflink self-check (card `bot_disk_lifecycle/reflink` on failure) |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H | unset (image default `hardlink`) | pnpm `package-import-method`: `hardlink`, `clone`, `clone-or-copy` or `copy`. `clone` is reflink-only: a failure is loud, never a silent copy; a file edit inside `node_modules` cannot corrupt the store (unlike a hardlink) | Unset — previous behaviour. An unknown value is rejected by the settings schema |

## settings-ru

| `general.botDisk.graceClosingMinutes` | 1.6.5-BOT-DISK-H | `30` | Отсрочка (в минутах) между переводом задачи в `closing` в желаемом состоянии (терминальный статус / переназначение / слитый PR) и удалением её worktree агентом botd; при жёстком давлении раздела (квота ≥ 100 %) действующая отсрочка равна 0 | От 5 до 1440; не задано или вне диапазона — умолчание. Меняется на странице Инстанс → Общие (`PATCH /api/myrmidon/bot-disk`), botd подхватывает со следующим чтением желаемого состояния, без перезапуска |
| `general.botDisk.scratchTtlHours` | 1.6.5-BOT-DISK-H | `24` | TTL простоя (в часах, по mtime/ctime) scratch-копии (класс G): после него botd архивирует её, если есть незапушенные коммиты, и удаляет — единственное место, где уместен таймер | От 1 до 720; не задано или вне диапазона — умолчание. При жёстком давлении раздела действующий TTL — 1 час |
| `general.botDisk.partitionThresholdPercent` | 1.6.5-BOT-DISK-H | `85` | Заполнение раздела ботов (физически, из dockergate `GET /myrmidon/disk`), при котором поднимается карточка экземпляра `host_disk_alert` с цифрами раздела | От 50 до 100; не задано или вне диапазона — умолчание |
| `general.botDisk.partitionRefuseOpenPercent` | 1.6.5-BOT-DISK-H | `90` | Заполнение раздела ботов, при котором `myr-ws open` отказывает **всем** ботам с `BOT_DISK_QUOTA_EXCEEDED:` (код 3), а все botd работают с отсрочкой 0 | От 50 до 100; не ниже `partitionThresholdPercent`; не задано или вне диапазона — умолчание |
| `general.botDisk.partitionCriticalPercent` | 1.6.5-BOT-DISK-H | `95` | Заполнение раздела ботов, при котором поднимается критическая карточка экземпляра и владельцу уходит сигнал в Telegram | От 50 до 100; не ниже `partitionRefuseOpenPercent`; не задано или вне диапазона — умолчание |
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H | не задано (хранилище на бота в монтировании workspace) | Каталог общего хранилища pnpm; по контракту обязан лежать **на разделе ботов** (одно хранилище на раздел), иначе reflink-импорт из него в тома ботов не работает (reflink не пересекает границу файловых систем) | Не задано — прежнее поведение. Задаётся в паре с `pnpmImportMethod: clone` и рабочей reflink-самопроверкой (при сбое — карточка `bot_disk_lifecycle/reflink`) |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H | не задано (умолчание образа `hardlink`) | `package-import-method` pnpm: `hardlink`, `clone`, `clone-or-copy` или `copy`. `clone` — только reflink: сбой звучит громко, а не превращается в тихую копию; правка файла внутри `node_modules` не портит хранилище (в отличие от жёсткой ссылки) | Не задано — прежнее поведение. Неизвестное значение отклоняется схемой настроек |

## settings-en-append

<!-- section: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 2 -->

### Task workspaces, the `myr-ws` CLI and the bot disk report (1.6.5 BOT-DISK-H, contract H0)

Inside the bot container the layout is fixed by the contract
(`docs/myrmidon/bot-disk-contract/README.md`):
`<HERMES_HOME>/.myrmidon/` holds `git-base/<owner>/<repo>.git` (bare bases),
`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}` plus `manifest.json`
(archives of removed copies with unpushed work), `ws-registry.json` (the open
copies: `{version:1, entries:[{key, repo?, path, class:'E'|'G', branch?,
openedAt}]}`) and `disk-state.json` (disk pressure `{quotaPercent,
partitionPercent, pressure:'none'|'soft'|'hard'}`, written by botd on every
pass, read by `myr-ws open`; a file older than two botd ticks reads as
`pressure:"none"`). Task copies are `/workspace/<ISSUE-KEY>` worktrees on
branch `bot/<KEY>`; scratch copies live at `/scratch/<name>`.

`myr-ws` commands: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
`list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; global `--json`
(`{ok:true, …}` per command, any error `{ok:false, error, exitCode}` with the
human-readable message on stderr). Exit codes: `0` ok, `2` invalid arguments,
`3` quota/disk refusal (message starts with `BOT_DISK_QUOTA_EXCEEDED:`), `4`
repository over the base limit (8), `5` network/fetch, `6` no such
copy/archive, `7` unpushed work without `--force`. Environment:
`MYRMIDON_TASK_WORKSPACE` (the opened copy's absolute path, exported into the
run), `MYRMIDON_WS_BIN` and `MYRMIDON_WS_HOME` (test-only overrides).

The board side is two routes, called with the bot's own `PAPERCLIP_API_KEY`:
`GET /api/myrmidon/bots/me/workspaces` returns the desired state
(`{generatedAt, grace:{closingMinutes, scratchTtlHours, orphanHours},
pressure, workspaces:[{key, repo, state:'active'|'closing', since, prState,
branch}]}`; on 401/403/503 botd is fail-safe and deletes nothing), and
`POST /api/myrmidon/bots/me/disk-report` accepts the bot's disk snapshot
(bases, copies with `clean`/`pushed` and sizes, archives, at most 200 recent
actions, foreign copies with their sign, self-check results; body ≤ 1 MiB)
and answers `{ok:true, nextReportSec}` as the next tick's tempo.

dockergate gains two routes: `GET /myrmidon/disk` (partition statfs plus the
per-project `xfs_quota report -p` parse; without prjquota mounted —
`projects:[]`, `quotaEnabled:false`) and
`PUT /myrmidon/disk/<botKey>/quota` with body `{bytes}` (64 MiB…1 TiB) →
`{ok:true, projectId, hardBytes}`; deny codes `route_not_allowed`,
`quota_unavailable`, `bad_quota`. The board executes the existing per-bot
quota setting `general.botDiskQuota` through them.

A `/v1/runs` request may carry `workspace: {key, repo, baseRef?}`: before the
model starts, the gateway runs `myr-ws open <key> <repo> [--base <baseRef>]
--json` and the run starts with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` as
cwd. Exit codes 3/4/5 do not fail the run silently: it starts in `/scratch`
with a warning event.

Attention cards (payload always carries `botKey` and `at`):
`bot_disk_lifecycle/agent-silent` (botd report older than 30 min in a running
container), `bot_disk_lifecycle/drift` (desired ≠ actual past grace + 15
min), `bot_disk_lifecycle/foreign` (a copy outside the base: promisor /
token in URL / no remote / `.trash-*` / full clone), `bot_disk_lifecycle/ws-cli`
and `bot_disk_lifecycle/reflink` (failed self-checks), `bot_image_stale` (bot
on a non-current image generation for over 24 h), `bot_disk_archive` (an
archive was created for the task; gone on restore or expiry).

## settings-ru-append

<!-- section: BOT-DISK E — host disk usage signal -->
<!-- occurrence: 1 -->

### Рабочие копии задач, CLI `myr-ws` и отчёт бота о диске (1.6.5 BOT-DISK-H, контракт H0)

Раскладка внутри контейнера бота зафиксирована контрактом
(`docs/myrmidon/bot-disk-contract/README.md`): `<HERMES_HOME>/.myrmidon/`
держит `git-base/<owner>/<repo>.git` (голые базы),
`archive/<KEY>-<ts>.{bundle,patch,untracked.tar}` и `manifest.json` (архивы
удалённых копий с незапушенной работой), `ws-registry.json` (открытые копии:
`{version:1, entries:[{key, repo?, path, class:'E'|'G', branch?, openedAt}]}`)
и `disk-state.json` (давление диска `{quotaPercent, partitionPercent,
pressure:'none'|'soft'|'hard'}` — пишет botd на каждом проходе, читает
`myr-ws open`; файл старше двух тиков botd читается как `pressure:"none"`).
Копии задач — worktree `/workspace/<ISSUE-KEY>` на ветке `bot/<KEY>`;
scratch-копии живут в `/scratch/<name>`.

Команды `myr-ws`: `open <KEY> [owner/repo] [--base <ref>] [--scratch]`,
`list`, `close <KEY> [--force]`, `restore <KEY>`, `migrate`; общий флаг
`--json` (`{ok:true, …}` по команде, любая ошибка — `{ok:false, error,
exitCode}`, человекочитаемое сообщение — на stderr). Коды выхода: `0` — ок,
`2` — неверные аргументы, `3` — отказ по квоте/диску (сообщение начинается с
`BOT_DISK_QUOTA_EXCEEDED:`), `4` — репозиторий сверх лимита баз (8), `5` —
сеть/fetch, `6` — нет такой копии/архива, `7` — незапушенная работа без
`--force`. Переменные: `MYRMIDON_TASK_WORKSPACE` (абсолютный путь открытой
копии, экспортируется в прогон), `MYRMIDON_WS_BIN` и `MYRMIDON_WS_HOME`
(подмены только для тестов).

Со стороны доски — два маршрута, вызываемые с ключом бота
`PAPERCLIP_API_KEY`: `GET /api/myrmidon/bots/me/workspaces` отдаёт желаемое
состояние (`{generatedAt, grace:{closingMinutes, scratchTtlHours,
orphanHours}, pressure, workspaces:[{key, repo, state:'active'|'closing',
since, prState, branch}]}`; при 401/403/503 botd в режиме fail-safe ничего не
удаляет), а `POST /api/myrmidon/bots/me/disk-report` принимает снимок диска
бота (базы, копии с флагами `clean`/`pushed` и размерами, архивы, не больше
200 последних действий, чужие копии с признаком, результаты самопроверок;
тело ≤ 1 МиБ) и отвечает `{ok:true, nextReportSec}` — темпом следующего
прохода.

dockergate получает два маршрута: `GET /myrmidon/disk` (statfs раздела плюс
разбор `xfs_quota report -p` по проектам; без смонтированного prjquota —
`projects:[]`, `quotaEnabled:false`) и
`PUT /myrmidon/disk/<botKey>/quota` с телом `{bytes}` (64 МиБ…1 ТиБ) →
`{ok:true, projectId, hardBytes}`; коды отказа `route_not_allowed`,
`quota_unavailable`, `bad_quota`. Через них доска исполняет существующую
настройку квоты на бота `general.botDiskQuota`.

Запрос `/v1/runs` может нести поле `workspace: {key, repo, baseRef?}`: до
старта модели гейтвей выполняет `myr-ws open <key> <repo> [--base <baseRef>]
--json`, и прогон стартует с `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` в
качестве рабочего каталога. Коды 3/4/5 не роняют прогон молча: он стартует в
`/scratch` с предупреждением в событиях.

Карточки внимания (payload всегда содержит `botKey` и `at`):
`bot_disk_lifecycle/agent-silent` (отчёт botd старше 30 минут при работающем
контейнере), `bot_disk_lifecycle/drift` (желаемое ≠ фактическому дольше
grace + 15 минут), `bot_disk_lifecycle/foreign` (копия вне базы: promisor /
токен в URL / без remote / `.trash-*` / полный клон),
`bot_disk_lifecycle/ws-cli` и `bot_disk_lifecycle/reflink` (проваленные
самопроверки), `bot_image_stale` (бот на образе не текущего поколения дольше
суток), `bot_disk_archive` (для задачи создан архив; исчезает при
восстановлении или истечении срока).

## divergence

| 1.6.5-BOT-DISK-H-CONTRACT-H0 | Интерфейсный контракт диска ботов (H0): раскладка `<HERMES_HOME>/.myrmidon/` (базы `git-base/`, архивы `archive/`, `ws-registry.json`, `disk-state.json`), CLI `myr-ws` (`open/list/close/restore/migrate`, `--json`, коды выхода 0/2–7, префикс отказа `BOT_DISK_QUOTA_EXCEEDED:`), маршруты доски `GET/POST /api/myrmidon/bots/me/workspaces|disk-report`, маршруты dockergate `GET /myrmidon/disk` и `PUT /myrmidon/disk/<botKey>/quota`, поле `workspace` запроса `/v1/runs` с фолбэком в `/scratch`, настройки `general.botDisk.*` и ключи карточек `bot_disk_lifecycle/*`, `bot_image_stale`, `bot_disk_archive`. Машинная форма — Zod-схемы и константы `packages/shared/src/myrmidon-bot-workspace.ts`, фикстуры `docs/myrmidon/bot-disk-contract/*.json`; текст — `docs/myrmidon/bot-disk-contract/README.md` | Вендорские файлы не тронуты: `packages/shared/src/myrmidon-bot-workspace.ts` (+ тест), `docs/myrmidon/bot-disk-contract/*`, `docs/myrmidon/changes/bot-disk-workspaces.md` (этот файл), SETTINGS/README — только документация | Все задачи эпика BOT-DISK-H (H1–H10) пишут код против одного контракта; без зафиксированных имён полей, кодов и форматов параллельные части не состыкуются. Пять релизов чинили хранение, но создание/удаление копий оставалось на боте и таймере — уборщик за сутки удалил 0 из 368 клонов | `packages/shared/src/myrmidon-bot-workspace.test.ts` (каждая фикстура проходит свою схему), `node scripts/myrmidon/release/collect-fragments.mjs --version 0.0.0 --dry-run` (этот фрагмент валиден), CI-сторож `scripts/myrmidon/ci/change-fragments-gate.mjs` | Никогда, это наш контракт. Изменение — только комментарием-изменением к документу contracts эпика с уведомлением затронутых задач | PR #702 (контракт), этот PR (документация) |
