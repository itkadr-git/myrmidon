---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### botd plans with a Date clock; the bot partition is measured over the dockergate socket (1.6.5 BOT-DISK-H, rc.9)

- botd deleted nothing on the production host: the loop handed the rules a
  `Date` as the clock, the rules only accepted a number or a string, read it as
  "no time" and returned an empty plan without a word. The rules now accept a
  `Date` (finite check included) and the loop passes epoch milliseconds.
- The host-disk sweep never measured the bot partition on a host where
  dockergate listens on a unix socket only: the client was built only from
  `MYRMIDON_DOCKERGATE_URL` (TCP), so the pressure stayed `0 / none` and the
  log said "host disk usage could not be read" every five minutes. The sweep
  now takes its client from the same socket the docker driver uses
  (`MYRMIDON_BOT_DOCKER_SOCKET`); the TCP client is built only when
  `MYRMIDON_DOCKERGATE_URL` is set and no socket is configured. A failing gate is
  still "not measured", never an error in the sweep.
- Deletion policy under `/workspace` is decided by the board's word about a task key, not by a
  timer. The directory name is normalized to a key (`ope3282v2`, `scratch-ope3213`,
  `.trash-OPE-4331`, `OPE-4915-stale-rootowned` -> `OPE-3282`, ...) and, in this order: the copy of
  an active task is never touched; a key in `protectKeys` (open, assigned to the bot) is kept and
  reported as `legacy-open`; a key in the new `closedKeys` (done/cancelled, no lookback limit) is
  archived and removed after the closing grace; a key the board lists elsewhere (reassigned, in
  review) is kept and reported `legacy-open-elsewhere`; a key-like name the board does not know is
  reported `unknown-key`; a name that is no task (`shared`, `tmp`, `work`, `srv-dev`) is reported
  `non-task`, and removed only when empty or regenerable. Under hard pressure the last three are
  archived after `legacyPressureIdleDays` (default 7; setting `general.botDisk.legacyPressureIdleDays`,
  also in `grace`), except `shared`. A timer applies to `/scratch` only. Without `closedKeys` (an older
  board) nothing under `/workspace` is removed.
- Nested repositories (a `.git` up to three levels below the directory) are seen by the classifier
  and archived one by one (`<KEY>--<relpath>`: bundle, patch, untracked files) before the
  directory is removed, next to a tar of the rest of the tree. A failed, missing or truncated archive
  of any part keeps the whole directory (`archive-incomplete`).
- The botd tick is the board's `nextReportSec` (300 s), clamped to 10 s..1 h. Directories that are
  only held are listed in the report as skipped actions (`legacy-open`, `legacy-open-elsewhere`,
  `unknown-key`, `non-task`).
- `botd --once --plan` is a dry run: it prints the inventory plan as JSON, executes nothing,
  writes no `disk-state.json` and sends no report.
- `general.botDisk.enabled=false` makes `GET /api/myrmidon/bots/me/workspaces` answer 503, which botd
  reads as "no desired state": nothing is removed.
- Operator note: `/cache/pnpm-store` is mounted read-write; the host source
  directory must belong to uid/gid 10001 (documented in the shared package cache
  steps).

## changelog-ru

### botd планирует с часами Date; раздел ботов меряется через сокет dockergate (1.6.5 BOT-DISK-H, rc.9)

- На боевом хосте botd ничего не удалял: цикл передавал правилам в качестве часов
  `Date`, правила принимали только число или строку, считали время неизвестным и
  молча возвращали пустой план. Правила теперь понимают `Date` (с проверкой на
  конечность), цикл передаёт миллисекунды.
- Свип диска хоста не измерял раздел ботов там, где dockergate слушает только
  unix-сокет: клиент строился лишь из `MYRMIDON_DOCKERGATE_URL` (TCP), поэтому
  давление оставалось `0 / none`, а в журнале каждые пять минут писалось «host disk
  usage could not be read». Теперь клиент берётся с того же сокета, что и docker-драйвер
  (`MYRMIDON_BOT_DOCKER_SOCKET`); TCP-клиент строится, только если задан
  `MYRMIDON_DOCKERGATE_URL` и сокет не задан. Недоступный шлюз — по-прежнему
  «не измерено», а не ошибка свипа.
- Удаление под `/workspace` решает слово доски о ключе задачи, а не таймер. Имя каталога
  приводится к ключу (`ope3282v2`, `scratch-ope3213`, `.trash-OPE-4331`,
  `OPE-4915-stale-rootowned` -> `OPE-3282`, ...) и по порядку: копия активной задачи не
  трогается; ключ в `protectKeys` (открыта, назначена боту) — остаётся, в отчёте `legacy-open`;
  ключ в новом `closedKeys` (done/cancelled, без ограничения по давности) — архив и удаление после
  grace; ключ, который доска знает в другом месте (переназначена, на ревью) — остаётся,
  `legacy-open-elsewhere`; похожее на ключ имя, которого доска не знает, — `unknown-key`; имя без
  задачи (`shared`, `tmp`, `work`, `srv-dev`) — `non-task`, удаляется только если пусто или
  регенерируемо. Под жёстким давлением последние три архивируются после `legacyPressureIdleDays`
  (по умолчанию 7; настройка `general.botDisk.legacyPressureIdleDays`, приходит и в `grace`), кроме
  `shared`. Таймер действует только в `/scratch`. Без `closedKeys` (старая доска) под `/workspace`
  ничего не удаляется.
- Вложенные репозитории (`.git` до трёх уровней вглубь) видит классификатор, и перед удалением
  каталога каждый архивируется отдельно (`<KEY>--<relpath>`: bundle, patch, неотслеживаемые файлы)
  вместе с tar остального дерева. Сбой, отсутствие или усечение архива любой части оставляет весь
  каталог на месте (`archive-incomplete`).
- Тик botd — `nextReportSec` доски (300 с) в пределах 10 с..1 ч. Каталоги, которые только
  удерживаются, перечислены в отчёте как пропущенные действия.
- `botd --once --plan` — сухой прогон: печатает план в JSON, ничего не исполняет, не пишет
  `disk-state.json` и не шлёт отчёт.
- `general.botDisk.enabled=false` — доска отвечает 503 на `GET /api/myrmidon/bots/me/workspaces`,
  botd читает это как «нет желаемого состояния» и ничего не удаляет.
- Для оператора: `/cache/pnpm-store` монтируется на запись; исходный каталог на хосте
  должен принадлежать uid/gid 10001 (описано в шагах общего кэша пакетов).

## divergence

| 1.6.5-BOT-DISK-H-rc9 | botd передаёт правилам миллисекунды, а правила понимают `Date`; свип диска хоста берёт клиента dockergate по unix-сокету (`MYRMIDON_BOT_DOCKER_SOCKET`), TCP — только при заданном `MYRMIDON_DOCKERGATE_URL` | Наши файлы: `docker/bot-runtime/botd/lib/{loop,rules}.js`, `docker/bot-runtime/botd/{botd,lib/*}`, `server/src/myrmidon/host-disk/{dockergate,index}.ts`, `server/src/myrmidon/bot-containers/bot-workspaces-{service,routes}.ts`, `packages/shared/src/myrmidon-bot-{disk,workspace}.ts` и тесты. Маркеров вендора нет: все файлы наши | botd ничего не удалял (часы Date), давление раздела всегда 0/none (нет TCP-адреса dockergate на боевом хосте) | `botd-loop.test.mjs`, `botd-rules.test.mjs` (Date-часы, реальные правила), `partition-client.myrmidon.test.ts` (выбор клиента, юнит-сокет, соответствие процентов) | Никогда, наше поведение | (этот PR) |
