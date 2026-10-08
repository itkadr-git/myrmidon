---
settings-section: BOT-DISK E — host disk usage signal
---

## changelog-en
### Task clones share one git object store per bot and per scope (1.6.5 BOT-DISK-G)

- Bot task clones copied the whole git history each (~0.4 GB; the volume grew
  ~4 GB/h): a bot terminal rebuilds PATH without the 1.6.2 git wrapper. The
  image now shadows git with `/usr/local/bin/git` and runs the wrapper with an
  absolute interpreter.
- The wrapper keeps one bare mirror per repository in the bot store (or the
  shared `/bot-scope/.git-objects` of an isolation scope); later clones borrow
  it with `--reference-if-able`. Measured here: first clone 414 MB / 144 MB
  `.git`, later clones 272 MB / 2 MB `.git`. Mirrors never prune objects a
  clone borrows; every failure falls back to a plain clone.
- The store used to stay empty next to live task clones: those clones run with
  `--reference <neighbour clone>`, the wrapper read that as the clone's own
  storage decision and stepped aside silently. Now only options that pick the
  storage of the clone's own objects opt out (`--dissociate`, `--shared`,
  `--local`, `--mirror`, `--filter`); clones naming `--reference`,
  `--reference-if-able` or `--no-local`, bounded clones (`--depth`,
  `--shallow-since`, `--shallow-exclude`) and non-GitHub clones keep the
  store's mirror as an extra alternate. `devbuild` follows the alternates.
- A clone the store does not serve is no longer silent: one `[myrmidon-git]`
  line on stderr plus `<HERMES_HOME>/.myrmidon/git-objects-last-error.json`.
  The start-time self-check (reported as `gitRefCheck`) runs a real offline
  reference round trip, plus `store-fills` and `store-in-use`; a failure raises
  an attention card (`gitref`, `bot_disk_lifecycle`).
- Switches: `MYRMIDON_GIT_LOCAL_MIRROR=""`, `MYRMIDON_GIT_LOCAL_MIRROR_REFRESH_SEC=0`,
  `MYRMIDON_GIT_OBJECTS_CHECK=0`. See [bot-disk-cache.md](bot-disk-cache.md).
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
