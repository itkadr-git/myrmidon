## changelog-en

### The pnpm store sits on the same mount as the task clones (OPE-12720)

- On the bots disk the shared pnpm store of 1.6.5-1.6.7 (`/cache/pnpm-store`) was on the root
  disk, while the task clones live under the bot's own bind mount. A hard link cannot cross a
  mount point, so pnpm copied ~3 GB of `node_modules` into every clone. The store is now
  `/workspace/.pnpm-store`: the per-bot store of BOT-DISK-D on the clones' own mount, chowned to
  the bot and skipped by the draft sweep. It is not `/bot/.pnpm-store`: the `/bot` root is
  root-owned (0711) on a production host, the bot user cannot create an entry there and every
  `pnpm install` would fail with `EACCES`.
- `/workspace/.pnpm-store` is also the previous image's own default, so the board can roll out
  before the image: the profile `.env` it rewrites for a bot whose container still runs the
  previous image names a path that image can write (no ordering between board and image is
  required). A stored `general.botDisk.pnpmStoreDir` of `/cache/pnpm-store` reads as
  `/workspace/.pnpm-store` with a note in the log; the setting accepts any path inside the
  bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) and refuses a path elsewhere
  (`/cache/...` included).
- The operator step is gone: `install -d <sharedPackageCachePath>/pnpm-store` is not needed, and
  the `pnpm-store` subdirectory is dropped from dockergate's mount list and prepare scripts, so
  deploy dockergate together with or after the board (the new dockergate refuses the old board's
  `pnpm-store` bind; the old dockergate accepts the new board's shorter list). The host
  subdirectory, if it exists, is unused and can be removed once no container of the previous
  layout runs. `/cache/pnpm` stays the download cache.
- Rollout for existing clones: their `node_modules/.modules.yaml` still has the old `storeDir`
  (`/cache/pnpm-store/...`). The first `pnpm install` in such a clone finds a different store,
  removes `node_modules` and installs again from the new store; without a TTY pnpm 10 asks for
  the removal and aborts (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The bot image's pnpm
  wrapper injects `--config.confirm-modules-purge=false` for `pnpm install`/`pnpm add` — the
  pinned pnpm 10.18.1 reads `confirmModulesPurge` from the command line only, not from
  `npm_config_*` or `.npmrc` — so an agent's plain `pnpm install` purges non-interactively.
  `pnpm add` and `pnpm update` refuse with `ERR_PNPM_UNEXPECTED_STORE` until it has run. New
  clones need nothing. The first install of each bot fills the new store from the download cache.
- Acceptance check: compare `df` of the bot partition before and after a fresh `pnpm install` in
  a new clone; the delta is the size of the packages that were new to the store, not the ~3 GB of
  a full `node_modules`. `du -xs node_modules` is not a check: it counts a linked file in full.
- Tests: the bot-disk-cache, template, docker-driver and profile-compile suites assert the new
  default (under `/workspace`, never at the `/bot` root or at `/cache/pnpm-store`), the absent
  bind and the migration; the image tests assert the Dockerfile and entrypoint defaults; the
  dockergate policy tests drop the `pnpm-store` pair; the pnpm-wrapper purge test
  (`pnpm-wrapper-purge.test.mjs`) asserts `--config.confirm-modules-purge=false` on
  install/add and its absence on the light lanes.

## changelog-ru

### Хранилище pnpm лежит на том же монтировании, что и клоны задач (OPE-12720)

- На диске ботов общее хранилище pnpm 1.6.5–1.6.7 (`/cache/pnpm-store`) лежало на корневом
  диске, а клоны задач — под собственным bind-монтированием бота. Жёсткая ссылка не пересекает
  точку монтирования, поэтому pnpm копировал ~3 ГБ `node_modules` в каждый клон. Теперь
  хранилище — `/workspace/.pnpm-store`: хранилище на бота из BOT-DISK-D на собственном
  монтировании клонов, отданное пользователю бота и пропускаемое очисткой черновиков. Это не
  `/bot/.pnpm-store`: корень `/bot` на боевом хосте принадлежит root (0711), пользователь бота
  не может создать там запись, и каждый `pnpm install` падал бы с `EACCES`.
- `/workspace/.pnpm-store` — и собственное умолчание прежнего образа, поэтому доску можно
  выкатывать раньше образа: `.env` профиля, который она переписывает боту с контейнером на
  прежнем образе, называет путь, доступный этому образу на запись (порядок «доска, затем образ»
  не нужен). Сохранённое `general.botDisk.pnpmStoreDir` со значением `/cache/pnpm-store`
  читается как `/workspace/.pnpm-store` с записью в журнал; настройка принимает любой путь
  внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`) и отклоняет путь в
  другом месте (в том числе `/cache/...`).
- Шаг оператора убран: `install -d <sharedPackageCachePath>/pnpm-store` не нужен, а подкаталог
  `pnpm-store` убран из списка монтирований dockergate и prepare-скриптов, поэтому dockergate
  выкатывают вместе с доской или после неё (новый dockergate отклоняет привязку `pnpm-store` старой
  доски; старый dockergate принимает более короткий список новой доски). Подкаталог на хосте,
  если он есть, не используется и его можно удалить, когда не осталось контейнеров прежней
  раскладки. `/cache/pnpm` остаётся кэшем загрузок.
- Выкат для существующих клонов: в их `node_modules/.modules.yaml` прежний `storeDir`
  (`/cache/pnpm-store/...`). Первый `pnpm install` в таком клоне видит другое хранилище,
  удаляет `node_modules` и ставит заново из нового хранилища; без TTY pnpm 10 просит
  подтвердить удаление и прерывается (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Обёртка
  pnpm образа бота подставляет `--config.confirm-modules-purge=false` для `pnpm install`/
  `pnpm add` — закреплённый pnpm 10.18.1 читает `confirmModulesPurge` только из командной
  строки, не из `npm_config_*` и не из `.npmrc` — поэтому обычный `pnpm install` агента
  удаляет `node_modules` без вопроса. `pnpm add` и `pnpm update` отказывают с
  `ERR_PNPM_UNEXPECTED_STORE`, пока он не выполнен. Новым клонам ничего не нужно. Первая
  установка каждого бота наполняет новое хранилище из кэша загрузок.
- Проверка приёмки: сравните `df` раздела ботов до и после свежего `pnpm install` в новом
  клоне; разница — размер пакетов, новых для хранилища, а не ~3 ГБ полного `node_modules`.
  `du -xs node_modules` проверкой не является: он считает файл-ссылку целиком.
- Тесты: наборы bot-disk-cache, template, docker-driver и profile-compile проверяют новое
  умолчание (под `/workspace`, никогда не в корне `/bot` и не `/cache/pnpm-store`), отсутствие
  привязки и миграцию; тесты образа проверяют умолчания Dockerfile и entrypoint; тесты политик
  dockergate убирают пару `pnpm-store`; тест обёртки pnpm (`pnpm-wrapper-purge.test.mjs`)
  проверяет `--config.confirm-modules-purge=false` у install/add и его отсутствие у лёгких
  команд.

## settings-en-replace

<!-- section: 1.6.1 — BOT-DISK B: shared package cache for bot containers -->
<!-- occurrence: 1 -->
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a (OPE-12720) | `/workspace/.pnpm-store` | Where pnpm keeps its store inside the bot container. The default is the per-bot store `/workspace/.pnpm-store`, on the same bind mount as the task clones, so pnpm links `node_modules` into it instead of copying (the shared `/cache/pnpm-store` of 1.6.5-1.6.7 was on the root disk, another mount than the clones). The path is writable by the bot user and is the image's own default; it is deliberately not under the root-owned `/bot` root. A path of the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) that is not the default is accepted with a warning in the log. Any other path is refused: a reflink or a hard link only works within one mount | `null` — the default. No operator step. A stored `/cache/pnpm-store` of an earlier release reads as the default. Existing clones re-install on their first `pnpm install`: see Rollout in `docs/myrmidon/bot-disk-cache.md` |

## settings-ru-replace

<!-- section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов -->
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a (OPE-12720) | `/workspace/.pnpm-store` | Где pnpm держит хранилище внутри контейнера бота. По умолчанию это хранилище на бота `/workspace/.pnpm-store` на том же bind-монтировании, что и клоны задач, поэтому pnpm ссылает в него `node_modules`, а не копирует (общее `/cache/pnpm-store` 1.6.5–1.6.7 лежало на корневом диске, другое монтирование, чем у клонов). Путь доступен на запись пользователю бота и является собственным умолчанием образа; он намеренно не в корне `/bot`, который принадлежит root. Путь внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`), не равный умолчанию, принимается с предупреждением в журнале. Любой другой путь отклоняется: reflink и жёсткая ссылка работают только внутри одного монтирования | `null` — по умолчанию. Шага оператора нет. Сохранённое прежним выпуском `/cache/pnpm-store` читается как значение по умолчанию. Существующие клоны переустанавливаются при первом `pnpm install`: см. «Выкат» в `docs/myrmidon/bot-disk-cache.ru.md` |
