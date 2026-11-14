## changelog-en

### One shared pnpm store for all bots again, on the bots' filesystem (OPE-12869)

- OPE-12720 moved the pnpm store into each bot's own tree (`/workspace/.pnpm-store`). On the
  bots disk that cost 2.4-2.6 GB per bot, the bots volume ran out of space and the bot rollout
  stopped. The store is back to ONE store for all bots: the host directory
  `<sharedPackageCachePath>/pnpm-store` bound read-write at `/cache/pnpm-store`, the sixth pair
  of the package cache mounts (dockergate's `PackageCacheMounts` and its prepare scripts list it
  again). The default `pnpmStoreDir` is `/cache/pnpm-store`; a stored `/workspace/.pnpm-store`
  reads as that default, and a path inside the bot's own tree stays allowed with a warning (a
  store per bot).
- Why this one shares: pnpm imports `node_modules` by reflink (`clone`), and a reflink works
  between mount points of ONE filesystem. The 1.6.5 shared store sat on the root disk, another
  filesystem than the bot volumes, so pnpm copied ~3 GB into every clone. The cache root must
  now be on the same XFS filesystem as the bot volumes (outside `MYRMIDON_BOT_VOLUME_ROOT`), for
  example `/srv/myrmidon-xfs/package-cache`: the store then costs one physical copy for all
  bots. The board cannot see the host filesystems, so this is an operator requirement; the
  start-time reflink self-check of the bot image (`hardlink-check.json`) reports a store on
  another filesystem.
- Operator steps: create `<packageCacheRoot>/pnpm-store` owned by 10001:10001 on the bots
  filesystem, deploy dockergate together with or before the board (the old dockergate refuses
  the `pnpm-store` bind with `mount_source_not_allowed`), then the board. Existing clones have
  the per-bot `storeDir` in `node_modules/.modules.yaml`; the first `pnpm install` there purges
  and reinstalls from the shared store (the pnpm wrapper's
  `--config.confirm-modules-purge=false` from OPE-12720 stays: pnpm 10 aborts the purge without
  a TTY otherwise). The per-bot `workspace/.pnpm-store` directories are unused afterwards and
  can be removed.
- The image's own default `npm_config_store_dir` stays `/workspace/.pnpm-store` (a bot without
  the cache bind has no `/cache/pnpm-store`, and its root filesystem is read-only); the board's
  profile `.env` overrides it for bots with the shared cache.
- Tests: the bot-disk-cache, template, docker-driver and profile-compile suites and the
  dockergate policy and contract fixtures are back to the six-pair list; a new case asserts that
  two bots get the same store mount and the same store variable.

## changelog-ru

### Снова одно общее хранилище pnpm на всех ботов, на файловой системе ботов (OPE-12869)

- OPE-12720 перенёс хранилище pnpm в дерево каждого бота (`/workspace/.pnpm-store`). На диске
  ботов это дало 2,4–2,6 ГБ на бота, том ботов заполнился, перекат ботов остановился.
  Хранилище снова ОДНО на всех ботов: каталог хоста `<sharedPackageCachePath>/pnpm-store`,
  привязанный на запись как `/cache/pnpm-store`, шестая пара монтирований кэша пакетов (её
  снова перечисляют `PackageCacheMounts` dockergate и его prepare-скрипты). `pnpmStoreDir` по
  умолчанию — `/cache/pnpm-store`; сохранённое `/workspace/.pnpm-store` читается как это
  значение, путь внутри дерева бота остаётся допустимым с предупреждением (хранилище на бота).
- Почему оно общее: pnpm импортирует `node_modules` reflink'ом (`clone`), а reflink работает
  между монтированиями ОДНОЙ файловой системы. Общее хранилище 1.6.5 лежало на корневом диске,
  то есть на другой файловой системе, чем тома ботов, и pnpm копировал ~3 ГБ в каждый клон.
  Теперь корень кэша должен быть на той же файловой системе XFS, что и тома ботов (вне
  `MYRMIDON_BOT_VOLUME_ROOT`), например `/srv/myrmidon-xfs/package-cache`: хранилище тогда
  стоит одну физическую копию на всех ботов. Доска не видит файловые системы хоста, поэтому
  это требование к оператору; самопроверка reflink при запуске образа бота
  (`hardlink-check.json`) сообщит о хранилище на другой файловой системе.
- Шаги оператора: создать `<packageCacheRoot>/pnpm-store` с владельцем 10001:10001 на
  файловой системе ботов, выкатить dockergate вместе с доской или раньше неё (старый dockergate
  отклоняет привязку `pnpm-store` с `mount_source_not_allowed`), затем доску. У существующих
  клонов в `node_modules/.modules.yaml` прежний `storeDir`: первый `pnpm install` удалит
  `node_modules` и поставит заново из общего хранилища (флаг
  `--config.confirm-modules-purge=false` в обёртке pnpm из OPE-12720 остаётся: pnpm 10 без TTY
  иначе прерывает удаление). Каталоги `workspace/.pnpm-store` ботов после этого не нужны, их
  можно удалить.
- Собственное умолчание образа `npm_config_store_dir` остаётся `/workspace/.pnpm-store` (у бота
  без привязки кэша нет `/cache/pnpm-store`, а его корневая файловая система только для
  чтения); `.env` профиля доски переопределяет его для ботов с общим кэшем.
- Тесты: наборы bot-disk-cache, template, docker-driver и profile-compile, а также политика и
  фикстуры контракта dockergate снова на списке из шести пар; новый случай проверяет, что два
  бота получают одну точку монтирования хранилища и одну переменную хранилища.

## settings-en-replace

<!-- section: 1.6.1 — BOT-DISK B: shared package cache for bot containers -->
<!-- occurrence: 1 -->
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a (OPE-12869) | `/cache/pnpm-store` | Where pnpm keeps its store inside the bot container. The default is the ONE store shared by all bots, `<sharedPackageCachePath>/pnpm-store` bound read-write at `/cache/pnpm-store`; the cache root must be on the same filesystem as the bot volumes, so pnpm's reflink import (`clone`) shares the store's blocks instead of copying. A path of the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is a store per bot and is accepted with a warning in the log. Any other path is refused: a reflink only works within one filesystem | `null` — the default. Operator step: `install -d -o 10001 -g 10001 <sharedPackageCachePath>/pnpm-store` on the bot-volume filesystem. A stored `/workspace/.pnpm-store` reads as the default |

## settings-ru-replace

<!-- section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов -->
| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a (OPE-12869) | `/cache/pnpm-store` | Где pnpm держит хранилище внутри контейнера бота. По умолчанию это ОДНО хранилище на всех ботов, `<sharedPackageCachePath>/pnpm-store`, привязанное на запись как `/cache/pnpm-store`; корень кэша должен быть на той же файловой системе, что и тома ботов, тогда импорт pnpm через reflink (`clone`) делит блоки хранилища, а не копирует. Путь внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`) — хранилище на бота, принимается с предупреждением в журнале. Любой другой путь отклоняется: reflink работает только внутри одной файловой системы | `null` — по умолчанию. Шаг оператора: `install -d -o 10001 -g 10001 <sharedPackageCachePath>/pnpm-store` на файловой системе томов ботов. Сохранённое `/workspace/.pnpm-store` читается как значение по умолчанию |
