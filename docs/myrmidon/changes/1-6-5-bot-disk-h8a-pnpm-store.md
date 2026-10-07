---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### One pnpm store per partition, imported by reflink (1.6.5 BOT-DISK-H, part H8a)

- The pnpm store of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/pnpm-store` on the host, bound
  read-write at `/cache/pnpm-store` into every bot of `sharedCacheRoles`.
  `npm_config_store_dir` points at it. It replaces the per-bot
  `/workspace/.pnpm-store` (eight stores of about 2.4 GiB each on the production
  fleet).
- `npm_config_package_import_method` is `clone` by default: a reflink, the copy
  shares the store's blocks and a write to a file in `node_modules` never reaches
  the store. Strictly `clone`: `clone-or-copy` and `hardlink` are refused by
  `PATCH /api/myrmidon/bot-disk` with a message, because pnpm copies silently
  where a reflink is refused.
- Values stored by an earlier release read as today's: `pnpmStoreDir`
  `/workspace/.pnpm-store` as `/cache/pnpm-store`, `pnpmImportMethod`
  `hardlink` or `clone-or-copy` as `clone`. Each migration is logged as a
  warning, as is a store inside a bot's own tree (a store per bot, not shared).
- dockergate: the `pnpm-store` pair joins the writable package cache mounts.
  Update dockergate BEFORE the board, otherwise the create of a bot with the
  shared cache is refused with `mount_source_not_allowed`.

## changelog-ru

### Один pnpm-store на раздел, импорт reflink'ом (1.6.5 BOT-DISK-H, часть H8a)

- Хранилище pnpm ботов с общим кэшем пакетов теперь ОДНО на раздел: на хосте
  `<sharedPackageCachePath>/pnpm-store`, привязывается на запись как
  `/cache/pnpm-store` каждому боту из `sharedCacheRoles`. `npm_config_store_dir`
  указывает на него. Оно заменяет хранилище на бота `/workspace/.pnpm-store`
  (на боевом парке восемь штук по ~2,4 ГиБ).
- `npm_config_package_import_method` по умолчанию `clone`: reflink, копия делит
  блоки с хранилищем, а запись в файл в `node_modules` до хранилища не
  доходит. Строго `clone`: `clone-or-copy` и `hardlink`
  `PATCH /api/myrmidon/bot-disk` отклоняет с сообщением, потому что pnpm молча
  копирует там, где reflink отказал.
- Значения, сохранённые прежним выпуском, читаются как сегодняшние:
  `pnpmStoreDir` `/workspace/.pnpm-store` как `/cache/pnpm-store`,
  `pnpmImportMethod` `hardlink` и `clone-or-copy` как `clone`. Каждая миграция
  пишется в журнал предупреждением, так же как хранилище внутри дерева бота
  (хранилище на бота, не общее).
- dockergate: пара `pnpm-store` входит в записываемые привязки кэша пакетов.
  Обновлять dockergate ДО доски, иначе создание бота с общим кэшем отклоняется
  с `mount_source_not_allowed`.

## settings-en

| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a | `/cache/pnpm-store` | Where pnpm keeps its store inside the bot container. The default is the shared store of the partition (host `<sharedPackageCachePath>/pnpm-store`, bound read-write to every bot of `sharedCacheRoles`). A path inside the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is accepted with a warning in the log: it is a store per bot, not shared, counted in the bot's quota. Any other path is refused: a reflink only works within one filesystem | `null` — the default. **Operator step:** `install -d -o 10001 <sharedPackageCachePath>/pnpm-store` on the partition of the bot volumes, before the settings are saved. A stored `/workspace/.pnpm-store` of an earlier release reads as the default |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H8a | `clone` | How pnpm puts a package into a clone: `clone` (reflink, strictly: a refused reflink fails loudly) or `copy` (an explicit full copy). `clone-or-copy` (silent copy) and `hardlink` (cannot cross the bind mounts of the shared store) are refused with a message | `null` — the default. A stored `hardlink` or `clone-or-copy` of an earlier release reads as `clone` |

## settings-ru

| `general.botDisk.pnpmStoreDir` | 1.6.5-BOT-DISK-H8a | `/cache/pnpm-store` | Где pnpm держит хранилище внутри контейнера бота. По умолчанию это общее хранилище раздела (на хосте `<sharedPackageCachePath>/pnpm-store`, привязывается на запись каждому боту из `sharedCacheRoles`). Путь внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`) принимается с предупреждением в журнале: это хранилище на бота, не общее, оно считается в квоте бота. Любой другой путь отклоняется: reflink работает только внутри одной файловой системы | `null` — по умолчанию. **Шаг оператора:** `install -d -o 10001 <sharedPackageCachePath>/pnpm-store` на разделе томов ботов, до сохранения настроек. Сохранённое прежним выпуском `/workspace/.pnpm-store` читается как значение по умолчанию |
| `general.botDisk.pnpmImportMethod` | 1.6.5-BOT-DISK-H8a | `clone` | Как pnpm кладёт пакет в клон: `clone` (reflink, строго: отказ reflink'а громкий) или `copy` (явная полная копия). `clone-or-copy` (тихая копия) и `hardlink` (не пересекает привязки общего хранилища) отклоняются с сообщением | `null` — по умолчанию. Сохранённые прежним выпуском `hardlink` и `clone-or-copy` читаются как `clone` |

## divergence

| 1.6.5-BOT-DISK-H8a | Хранилище pnpm одно на раздел: привязка `<sharedPackageCachePath>/pnpm-store` → `/cache/pnpm-store` на запись, `npm_config_store_dir` и метод импорта `clone` по умолчанию (строго, без `clone-or-copy`); валидация настроек (`clone-or-copy` и `hardlink` отклоняются, хранилище в дереве бота — предупреждение, чужой путь отклоняется); чтение старых значений с миграцией и записью в журнал; пара `pnpm-store` в dockergate | Наши файлы: `packages/shared/src/myrmidon-bot-disk.ts` (`BOT_DISK_*_PNPM_*`, `botDiskPnpmStoreDirProblem/Warning`, `botDiskPnpmImportMethodProblem`, `migrateBotDiskPnpm`, `botDiskPnpmWarnings`), `server/src/myrmidon/bot-containers/template.ts` (`DEFAULT_PNPM_STORE_DIR`, `DEFAULT_PNPM_IMPORT_METHOD`, `PNPM_STORE_ROOTS`, `PACKAGE_CACHE_MOUNTS`), `bot-disk-service.ts` (запись предупреждений), `tools/dockergate/internal/policy/create.go` (`PackageCacheMounts`) и тесты `bot-disk-cache`, `template`, `docker-driver`, `profile-compile` (`*.myrmidon.test.ts`), `create_test.go`. Маркеров вендора нет: все файлы наши | Проект BOT-DISK-H (часть H8): пять выпусков чинили хранение жёсткими ссылками, а они ломаются на границе привязок; reflink на одном разделе снимает копии пакетов в каждом клоне. Требование тикета OPE-5367 | `bot-disk-cache.myrmidon.test.ts` (умолчания, привязка и env, `clone-or-copy` и `hardlink` отклонены с сообщением, `/workspace` — предупреждение, миграция старых значений), `template.myrmidon.test.ts`, `docker-driver.myrmidon.test.ts`, `create_test.go` (пара `pnpm-store` принята) | Никогда, наше поведение. Снятие: удалить пару `pnpm-store` из `PACKAGE_CACHE_MOUNTS` и `PackageCacheMounts`, `migrateBotDiskPnpm`, предупреждения и вернуть прежние умолчания | (этот PR) |
