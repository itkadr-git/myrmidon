---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Build offload C: dev-variant bot containers get DEVBUILD env and the build-server ssh key (BUILD-OFFLOAD C)

- New board settings `MYRMIDON_DEVBUILD_HOST` / `MYRMIDON_DEVBUILD_USER`
  (default `devbuild`) / `MYRMIDON_DEVBUILD_BASE` (default `/srv/devbuild`).
  When HOST is set, every NEW dev-variant bot container (`myrmidon-hermes-dev`
  images, detected by the image reference's last segment) receives
  `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` in its container env — an
  internal hostname and paths, not secrets — plus a read-only mount of the
  build server's ssh key at `/opt/devbuild-ssh`; the key's host directory is
  taken from `MYRMIDON_BOT_MOUNT_SOURCES` (an entry ending in `devbuild-ssh`).
  The create body always carries `Env` (`[]` when the feature is off).
- The mount point `/opt/devbuild-ssh` is added to `RESERVED_CONTAINER_PATHS`:
  a card's own `extraMounts` cannot take it over. Secrets never travel in the
  container `Env` — docker inspect would disclose them; keys travel as files.
- dockergate learned the `Env` list of the bot create body: empty or exactly
  the three `DEVBUILD_*` entries in builder order, anything else is denied
  (`deny.JSONUnknownKey`/`deny.JSONValue`); contract fixtures regenerated.

## changelog-ru

### Вынос сборок C: dev-контейнеры ботов получают DEVBUILD env и ssh-ключ сборочного VPS (BUILD-OFFLOAD C)

- Новые настройки доски `MYRMIDON_DEVBUILD_HOST` / `MYRMIDON_DEVBUILD_USER`
  (умолчание `devbuild`) / `MYRMIDON_DEVBUILD_BASE` (умолчание `/srv/devbuild`).
  Если HOST задан, каждый НОВЫЙ контейнер бота dev-варианта (образы
  `myrmidon-hermes-dev`, определение по последнему сегменту ссылки образа)
  получает в env контейнера `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` —
  внутреннее имя хоста и пути, не секреты — и read-only монтирование ssh-ключа
  сборочного сервера в `/opt/devbuild-ssh`; хостовый каталог ключа берётся из
  `MYRMIDON_BOT_MOUNT_SOURCES` (запись, оканчивающаяся на `devbuild-ssh`).
  Тело create теперь всегда несёт `Env` (`[]`, когда фича выключена).
- Точка монтирования `/opt/devbuild-ssh` добавлена в `RESERVED_CONTAINER_PATHS`:
  карточка бота не может занять её своими `extraMounts`. Секреты в `Env`
  контейнера не попадают — docker inspect их раскрывает; ключ едет файлом.
- dockergate знает про список `Env` в теле create бота: пустой список или ровно
  три записи `DEVBUILD_*` в порядке билдера, всё остальное отклоняется;
  контрактные фикстуры перегенерированы.

## settings-en

| `MYRMIDON_DEVBUILD_HOST` | BUILD-OFFLOAD-C | unset (off) | Hostname of the build server on which dev-variant bots (`myrmidon-hermes-dev` images) run builds, tests and caches instead of the board host (BUILD-OFFLOAD A/B). When set, every NEW dev-variant bot container gets `DEVBUILD_HOST`/`DEVBUILD_USER`/`DEVBUILD_BASE` in its container env (internal hostname and paths, not secrets) plus a read-only mount of the build server's ssh key at `/opt/devbuild-ssh`; the key's host directory is taken from `MYRMIDON_BOT_MOUNT_SOURCES` — an entry ending in `devbuild-ssh`. The mount point `/opt/devbuild-ssh` is reserved: a card's own `extraMounts` cannot take it over | Unset — the feature is off: containers get no DEVBUILD env and no key mount |
| `MYRMIDON_DEVBUILD_USER` | BUILD-OFFLOAD-C | `devbuild` | ssh user on the build server, written as `DEVBUILD_USER` into dev-variant bot containers | Read together with `MYRMIDON_DEVBUILD_HOST`; without it the value is not used at all |
| `MYRMIDON_DEVBUILD_BASE` | BUILD-OFFLOAD-C | `/srv/devbuild` | Base directory of per-task build workspaces on the build server, written as `DEVBUILD_BASE` into dev-variant bot containers | Read together with `MYRMIDON_DEVBUILD_HOST`; without it the value is not used at all |
