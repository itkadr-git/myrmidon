---
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en

### Task clones share one git object store per bot and per scope (1.6.5 BOT-DISK-G)

- The bot volume grew ~4 GB/h: every task clone copied the whole git history
  (~0.4 GB each) even with the board's `/cache/git` mirrors, because a bot
  terminal rebuilds PATH without `/opt/paperclip/bin`, where the 1.6.2 wrapper
  stood — a bare `git clone` ran the real git, and the wrapper itself died with
  127 outside the image PATH (`#!/usr/bin/env node`). The dev image now shadows
  git with a `/usr/local/bin/git` symlink (an element every rebuilt PATH keeps)
  and runs the wrapper with an absolute interpreter.
- The wrapper keeps a bare mirror per repository inside the bot's own mount —
  `${MYRMIDON_GIT_LOCAL_MIRROR:-<HERMES_HOME>/.myrmidon/git-objects}`, or the
  shared store `/bot-scope/.git-objects` the profile compiler gives to members
  of an isolation-scope instance (issue #574 scope: objects then live once per
  scope, not per bot) — and makes every clone after the first borrow its
  objects with `--reference-if-able`. The first clone of a repository pays one
  full fetch; later clones store only their working tree and their own
  commits. The mirrors never prune objects a clone may still borrow
  (`gc.pruneExpire=never`, `gc.auto=0`), the refresh is throttled behind a
  lock, the board's mirror still wins when mounted, and every failure falls
  back to a plain clone. The store lives in the bot's hermes home (or the
  scope root), so no clone lifecycle ever reaps it.
- The entrypoint runs a shared-objects self-check at every start, by the hard-link
  self-check's pattern: the shadow answers, the wrapper runs, the store is
  writable, and a real offline `--reference-if-able` round trip borrows
  objects. The result rides the clone-hygiene report (`gitRefCheck`); a failed
  check raises a `bot_disk_lifecycle` attention card per bot, gone at the next
  clean start.
- On the fleet the store stayed empty next to live GitHub task clones. The task
  clones on a bot name another local clone in their `objects/info/alternates`
  file, and only `--reference` (or `--shared`) writes that entry: the clone runs
  with `--reference <neighbour clone>`, and the wrapper read `--reference` as
  the clone's own storage decision, so it stepped aside — in silence, without a
  mirror and without a trace. Reproduced with the old wrapper: a
  `git clone --reference <neighbour> https://github.com/<owner>/<repo> <dir>`
  leaves the store empty and prints no line. The opt-outs are now only the
  options that pick the storage of the clone's own objects (`--dissociate`,
  `--shared`, `--local`, `--mirror`, `--filter`); a clone that names
  `--reference`/`--reference-if-able`/`--no-local`, a bounded clone (`--depth`,
  `--shallow-since`, `--shallow-exclude`) and a non-GitHub clone keep the store's
  mirror as one more alternate. The field command line through both wrappers:
  the old one leaves the store empty, the new one leaves
  `<store>/<owner>/<repo>.git` and an `alternates` entry.
- A clone the store does not serve is no longer silent: the wrapper prints one
  `[myrmidon-git]` line on stderr and writes
  `<HERMES_HOME>/.myrmidon/git-objects-last-error.json` (kind, reason, detail,
  the command line, one counter per kind). The clone still never fails because
  of the store.
- The start-time check gained two steps: `store-fills` runs the task clone's own
  command line (a bounded clone that also names a stale `--reference-if-able`)
  through the wrapper and requires a mirror in the store plus an alternates
  entry, and `store-in-use` fails when GitHub task clones exist below
  `/workspace` or `/scratch` and the store holds no mirror. The silent fleet
  state now raises the `gitref` card.
- `devbuild` follows the alternates: a borrowed mirror is synced once to the
  build host's `/srv/devcache/git` and the synced clone's `objects/info/alternates`
  is repointed at it, so git commands in a remote build keep working against
  reference-cloned task workspaces.
- Measured on this repository (full history, `myrmidon@29ae84e5`): a fresh
  clone without a store: 414 MB / 25.5 s, `.git` 144 MB; with the bot store
  mirrored: 272 MB / 1.1 s, `.git` 2 MB (the working tree of 270 MB is
  unchanged); the store itself 145 MB once per bot/scope. Each further clone
  of the same repository adds ~270 MB, not ~414 MB, and borrows the same
  history; before the fix every clone re-downloaded and re-stored ~144 MB of
  shared objects.
- Disable switches: `MYRMIDON_GIT_LOCAL_MIRROR=""` (no bot store),
  `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0` (never refetch),
  `MYRMIDON_GIT_OBJECTS_CHECK=0` (skip the start-time check). See
  [bot-disk-cache.md](bot-disk-cache.md).

## changelog-ru

### Клоны задач делят одно хранилище объектов git на бота и на область (1.6.5 BOT-DISK-G)

- Том ботов рос примерно на 4 ГБ/ч: каждый клон задачи копировал всю историю
  git (~0,4 ГБ), даже когда у доски были зеркала `/cache/git`, — терминал бота
  пересобирает PATH без `/opt/paperclip/bin`, где стояла обёртка 1.6.2: голый
  `git clone` шёл настоящим git, а сама обёртка вне image-PATH умирала с 127
  (`#!/usr/bin/env node`). Теперь dev-образ затеняет git символьной ссылкой
  `/usr/local/bin/git` (элемент, который остаётся в любом пересобранном PATH),
  и обёртка запускается абсолютным интерпретатором.
- Обёртка держит bare-зеркало на репозиторий внутри монтирования самого бота —
  `${MYRMIDON_GIT_LOCAL_MIRROR:-<HERMES_HOME>/.myrmidon/git-objects}`, либо
  общее хранилище `/bot-scope/.git-objects`, которое компилятор профилей даёт
  членам экземпляра изоляции (область #574: объекты живут один раз на область,
  а не на бота) — и каждый следующий клон одалживает объекты через
  `--reference-if-able`. Первый клон репозитория платит одной полной
  загрузкой; последующие хранят только рабочее дерево и свои коммиты. Зеркала
  никогда не удаляют объекты, которые кто-то одалживает
  (`gc.pruneExpire=never`, `gc.auto=0`), обновление throttled-ном под блокировкой,
  зеркало доски по-прежнему приоритетно, при любой неудаче клон делается как
  раньше — обычной копией. Хранилище лежит в hermes-доме бота (или в корне
  области), поэтому жизненный цикл клонов его не удаляет.
- На каждом старте контейнера entrypoint делает самопроверку общих объектов —
  по образцу самопроверки жёстких ссылок: тень отвечает, обёртка запускается,
  хранилище доступно на запись, реальный офлайн-цикл `--reference-if-able`
  одалживает объекты. Результат едет в отчёте clone-hygiene (`gitRefCheck`);
  провалившаяся проверка поднимает карточку `bot_disk_lifecycle` на бота,
  исчезающую при следующем чистом старте.
- На бою хранилище оставалось пустым рядом с живыми GitHub-клонами задач: клоны
  задач на боте называют в `objects/info/alternates` другой локальный клон, а
  такую запись пишет только `--reference` (или `--shared`), то есть клон шёл с
  `--reference <соседний клон>`, и обёртка принимала `--reference` за решение
  клона о своём хранении — отступала молча, без зеркала и без следа.
  Воспроизведение на старой обёртке: `git clone --reference <сосед>
  https://github.com/<owner>/<repo> <dir>` оставляет хранилище пустым и не
  печатает ни строки. Opt-out'ами теперь остались только опции, выбирающие
  хранение собственных объектов клона (`--dissociate`, `--shared`, `--local`,
  `--mirror`, `--filter`); клон с `--reference`/`--reference-if-able`/
  `--no-local`, клон с ограниченной историей (`--depth`, `--shallow-since`,
  `--shallow-exclude`) и клон не-GitHub адреса берут зеркало хранилища ещё
  одной альтернативой — боевая командная строка на старой обёртке оставляет
  хранилище пустым, на новой — `<store>/<owner>/<repo>.git` и запись в
  `alternates`.
- Клон, которому хранилище не служит, больше не молчит: обёртка печатает одну
  строку `[myrmidon-git]` в stderr и пишет
  `<HERMES_HOME>/.myrmidon/git-objects-last-error.json` (вид, причина,
  подробность, командная строка, счётчик на каждый вид). Клон по-прежнему
  никогда не падает из-за хранилища.
- Самопроверка на старте получила две проверки: `store-fills` прогоняет через
  обёртку собственную командную строку клона задачи (клон с ограниченной
  историей и устаревшим `--reference-if-able`) и требует зеркало в хранилище и
  запись в alternates, а `store-in-use` падает, когда под `/workspace` или
  `/scratch` есть GitHub-клоны задач, а в хранилище нет ни одного зеркала.
  Молчаливое состояние боя теперь поднимает карточку `gitref`.
- `devbuild` проходит по alternates: одолженное зеркало один раз синхронизируется
  на сборочный хост в `/srv/devcache/git`, и `objects/info/alternates`
  синхронизированного клона переставляется на него, чтобы git на удалённой
  сборке работал с клонированными по reference рабочими копиями.
- Замер на этом репозитории (полная история, `myrmidon@29ae84e5`): свежий клон
  без хранилища: 414 МБ / 25,5 с, `.git` 144 МБ; с зеркалом в хранилище бота:
  272 МБ / 1,1 с, `.git` 2 МБ (рабочее дерево 270 МБ без изменений); само
  хранилище — 145 МБ один раз на бота/область. Каждый следующий клон того же
  репозитория добавляет ~270 МБ вместо ~414 МБ и одалживает ту же историю; до
  исправления каждый клон заново качал и хранил ~144 МБ общих объектов.
- Выключатели: `MYRMIDON_GIT_LOCAL_MIRROR=""` (без хранилища бота),
  `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0` (не обновлять),
  `MYRMIDON_GIT_OBJECTS_CHECK=0` (пропустить самопроверку на старте). См.
  [bot-disk-cache.md](bot-disk-cache.md).

## settings-en

| `MYRMIDON_GIT_LOCAL_MIRROR` | 1.6.5 BOT-DISK-G | `<HERMES_HOME>/.myrmidon/git-objects` (a scope member: `/bot-scope/.git-objects`, written by the profile compiler) | Bot-side directory of the bot's (or the scope's) bare git mirrors; the image's git wrapper clones GitHub repositories against it with `--reference-if-able`, so task clones store only their working tree. Must live inside the bot's single mount (or the scope instance's). Read by the wrapper from the environment or the profile's `.env` | `""` — off (every clone copies objects; the board's `/cache/git` mirror, when set, still applies). Related bot-side knobs: `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC` (default 900; `0` never refetches), `MYRMIDON_GIT_LOCAL_MIRROR_MAX` (default 8 repositories per store), `MYRMIDON_GIT_OBJECTS_CHECK` (`0` skips the start-time self-check) |

## settings-ru

| `MYRMIDON_GIT_LOCAL_MIRROR` | 1.6.5 BOT-DISK-G | `<HERMES_HOME>/.myrmidon/git-objects` (член области: `/bot-scope/.git-objects`, пишет компилятор профилей) | Каталог bare-зеркал git бота (или области); обёртка git из образа клонирует репозитории GitHub против него через `--reference-if-able`, поэтому клоны задач хранят только рабочее дерево. Должен лежать внутри единого монтирования бота (или экземпляра области). Обёртка читает переменную из окружения или из `.env` профиля | `""` — выключено (каждый клон копирует объекты; зеркало доски `/cache/git`, если задано, работает и раньше). Смежные переменные бота: `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC` (по умолчанию 900; `0` — не обновлять), `MYRMIDON_GIT_LOCAL_MIRROR_MAX` (по умолчанию 8 репозиториев на хранилище), `MYRMIDON_GIT_OBJECTS_CHECK` (`0` — пропустить самопроверку на старте) |
