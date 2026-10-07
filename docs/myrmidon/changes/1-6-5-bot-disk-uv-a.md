---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### One uv cache per partition, imported by reflink (1.6.5 BOT-DISK-UV, part A)

- The uv cache of the bots with the shared package cache is now ONE directory
  per partition: `<sharedPackageCachePath>/uv` on the host, bound read-write at
  `/cache/uv` into every bot of `sharedCacheRoles`. `UV_CACHE_DIR` points at it,
  `UV_LINK_MODE` is written next to it; both land in the profile's `hermes/.env`
  and win over the card's value (the dropped card value is logged as a warning,
  like the other cache variables).
- `UV_LINK_MODE` is `clone` by default: a reflink on a copy-on-write filesystem.
  `clone`, `hardlink` and `copy` are accepted. `symlink` is refused by
  `PATCH /api/myrmidon/bot-disk` with a message: environments reached through
  symlinks in the shared cache break bot isolation. Unlike pnpm, `hardlink` is
  allowed — it is a documented uv value, and uv itself fails loudly with an
  EXDEV error when a hard link cannot cross the bind; uv's own
  clone→hardlink→copy fallback (logged in the bot) is accepted, so there is no
  `clone-or-copy` analog and no separate ban.
- A cache inside a bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is
  accepted with a warning — it is a cache per bot, counted against the quota,
  not a shared one. Any other path is refused. This is a new feature: nothing to
  migrate, a stored profile without the keys reads as today's defaults.
- dockergate: the `uv` pair joins the writable package cache mounts. Update
  dockergate BEFORE the board, otherwise the create of a bot with the shared
  cache is refused with `mount_source_not_allowed`.

## changelog-ru

### Один кэш uv на раздел, импорт reflink'ом (1.6.5 BOT-DISK-UV, часть A)

- Кэш uv ботов с общим кэшем пакетов теперь ОДНА директория на раздел: на хосте
  `<sharedPackageCachePath>/uv`, привязывается на запись как `/cache/uv` каждому
  боту из `sharedCacheRoles`. `UV_CACHE_DIR` указывает на него, `UV_LINK_MODE`
  рядом; обе переменные пишутся в `hermes/.env` профиля и выигрывают у значения
  карточки (снятое значение карточки пишется в журнал предупреждением, как и у
  остальных cache-переменных).
- `UV_LINK_MODE` по умолчанию `clone`: reflink на copy-on-write файловой системе.
  Принимаются `clone`, `hardlink`, `copy`. `symlink` отклоняется
  `PATCH /api/myrmidon/bot-disk` с сообщением: окружения по симлинкам в общем
  кэше ломают изоляцию ботов. В отличие от pnpm, `hardlink` разрешён — это
  документированное значение uv, а при hardlink через привязку uv сам падает с
  понятной EXDEV-ошибкой; собственный fallback uv clone→hardlink→copy (видно в
  логе бота) принимается, поэтому аналога `clone-or-copy` нет и отдельный запрет
  не нужен.
- Кэш внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`)
  принимается с предупреждением в журнале: это кэш на бота, не общий, он
  считается в квоте бота. Любой другой путь отклоняется. Фича новая: мигрировать
  нечего, сохранённый профиль без ключей читается сегодняшними умолчаниями.
- dockergate: пара `uv` входит в записываемые привязки кэша пакетов. Обновлять
  dockergate ДО доски, иначе создание бота с общим кэшем отклоняется с
  `mount_source_not_allowed`.

## settings-en

| `general.botDisk.uvCacheDir` | 1.6.5-BOT-DISK-UV-A | `/cache/uv` | Where uv keeps its cache inside the bot container. By default this is the shared cache of the partition (on the host `<sharedPackageCachePath>/uv`, bound read-write to every bot of `sharedCacheRoles`). A path inside the bot's own tree (`/workspace`, `/data`, `/scratch`, `/bot`) is accepted with a log warning: it is a cache per bot, not shared, and it counts against the bot's quota. Any other path is refused: reflink works only inside one filesystem | `null` — the default. **Operator step:** `install -d -o 10001 <sharedPackageCachePath>/uv` on the bot-volumes partition, before saving the settings |
| `general.botDisk.uvLinkMode` | 1.6.5-BOT-DISK-UV-A | `clone` | How uv puts a wheel into the environment: `clone` (reflink on a CoW filesystem), `hardlink` (documented uv value; across the shared bind it fails loudly with EXDEV), or `copy` (explicit full copy). `symlink` is refused with a message — site-packages behind symlinks in the shared cache break bot isolation | `null` — the default. uv's own clone→hardlink→copy fallback stays in uv and is accepted |

## settings-ru

| `general.botDisk.uvCacheDir` | 1.6.5-BOT-DISK-UV-A | `/cache/uv` | Где uv держит кэш внутри контейнера бота. По умолчанию это общий кэш раздела (на хосте `<sharedPackageCachePath>/uv`, привязывается на запись каждому боту из `sharedCacheRoles`). Путь внутри дерева самого бота (`/workspace`, `/data`, `/scratch`, `/bot`) принимается с предупреждением в журнале: это кэш на бота, не общий, он считается в квоте бота. Любой другой путь отклоняется: reflink работает только внутри одной файловой системы | `null` — по умолчанию. **Шаг оператора:** `install -d -o 10001 <sharedPackageCachePath>/uv` на разделе томов ботов, до сохранения настроек |
| `general.botDisk.uvLinkMode` | 1.6.5-BOT-DISK-UV-A | `clone` | Как uv кладёт пакет в окружение: `clone` (reflink на CoW-ФС), `hardlink` (документированное значение uv; через привязку общего кэша падает громкой EXDEV-ошибкой) или `copy` (явная полная копия). `symlink` отклоняется с сообщением: site-packages за симлинками в общем кэше ломают изоляцию ботов | `null` — по умолчанию. Собственный fallback uv clone→hardlink→copy остаётся на uv и принимается |

## divergence

| 1.6.5-BOT-DISK-UV-A | Кэш uv один на раздел: привязка `<sharedPackageCachePath>/uv` → `/cache/uv` на запись, `UV_CACHE_DIR` и `UV_LINK_MODE` в `hermes/.env` профиля (значение доски выигрывает у карточки с предупреждением), `clone` по умолчанию; `hardlink` и `copy` разрешены (в отличие от pnpm: uv сам падает на EXDEV, его fallback принимается), `symlink` отклоняется (симулинки в общем кэше ломают изоляцию ботов); кэш в дереве бота — предупреждение, чужой путь отклоняется; пара `uv` в dockergate | Наши файлы: `packages/shared/src/myrmidon-bot-disk.ts` (`BOT_DISK_*_UV_*`, `botDiskUvCacheDirProblem/Warning`, `botDiskUvLinkModeProblem`, `botDiskUvWarnings`), `server/src/myrmidon/bot-containers/template.ts` (`DEFAULT_UV_CACHE_DIR`, `uvEnv`, `PACKAGE_CACHE_MOUNTS`), `server/src/myrmidon/bot-containers/profile-compile.ts` и `profile-ports.ts` (`uvSettings`), `server/src/myrmidon/bot-containers/bot-disk-service.ts` (журнал предупреждений), `tools/dockergate` (пара `uv`) | Проект BOT-DISK-UV: боты на uv скачивали wheels каждый сам; общий кэш раздела с reflink снимает и трафик, и место. Решения зафиксированы тикетом (default `clone`, `symlink` запрещён, `hardlink` разрешён) | `bot-disk-cache.myrmidon.test.ts` (умолчания, привязка и env, `symlink` отклонён с сообщением, `/workspace` — предупреждение, чужой путь отклонён), `template.myrmidon.test.ts` и `docker-driver.myrmidon.test.ts` (bind `<cache>/uv`), `profile-compile.myrmidon.test.ts` (пара в `hermes/.env`, снятие значения карточки), `create_test.go` (пара `uv` принята) | Никогда, наше поведение. Снятие: удалить пару `uv` из `PACKAGE_CACHE_MOUNTS` и `PackageCacheMounts`, ключи `uvCacheDir`/`uvLinkMode` из схемы, `uvEnv` из env | (этот PR) |
