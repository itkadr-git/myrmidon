---
settings-section: Track 3 — tool gateway and Hermes adapter
---

## changelog-en

### The pnpm store is per bot inside its /bot mount again (OPE-12720)

- The shared per-partition store of 1.6.5-1.6.7 (`/cache/pnpm-store`, the `pnpm-store` bind of the
  shared package cache) is retired. A store bind to a read-write directory outside the bot's own
  tree only carried a reflink across bots and only for those with the shared cache; bots without
  it kept a store inside their workspace. One store per bot, inside the one `/bot` mount every
  bot already has, works for every bot the same way.
- The default store is `/bot/.pnpm-store` again (as it was before 1.6.5). The setting
  `general.botDisk.pnpmStoreDir` accepts any path inside the bot's own tree (`/workspace`,
  `/data`, `/scratch`, `/bot`); a path elsewhere (`/cache/...` included) is refused. A stored
  value of either retired default (`/workspace/.pnpm-store` of pre-1.6.5, `/cache/pnpm-store` of
  1.6.5-1.6.7) migrates to `/bot/.pnpm-store` with a note in the log.
- The operator step is gone: no `install -d <sharedPackageCachePath>/pnpm-store`, no
  `packageCacheRoot/pnpm-store` subdirectory in dockergate's mount list or prepare scripts; the
  host subdirectory, if it exists, just stops being used.
- `/cache/pnpm` stays the download cache (`npm_config_cache_dir`), as it is since BOT-DISK-D.
- The omp SSH runner (`omp_local` agents) pins its store inside its own workspace:
  `npm_config_store_dir=/workspace/.pnpm-store` in `omp-ssh/compose.yml`. Without the variable
  pnpm resolves the store from the cwd convention and misses for commands run outside the
  workspace; `clone-or-copy` keeps installs working on filesystems without reflink.
- Tests: the bot-disk-cache, template, docker-driver and profile-compile suites assert the new
  default, the absent bind and the migration; dockergate policy tests drop the `pnpm-store` pair.

## changelog-ru

### Хранилище pnpm снова у каждого бота, внутри его монтирования /bot (OPE-12720)

- Общее хранилище раздела 1.6.5–1.6.7 (`/cache/pnpm-store`, привязка `pnpm-store` общего кэша
  пакетов) выведено из использования. Привязка хранилища к каталогу на запись вне дерева самого
  бота переносила reflink между ботами и только для тех, у кого есть общий кэш; боты без кэша
  держали хранилище внутри своего workspace. Одно хранилище на бота, внутри единственного
  монтирования `/bot`, которое есть у каждого бота, работает одинаково для всех.
- Хранилище по умолчанию снова `/bot/.pnpm-store` (как до 1.6.5). Настройка
  `general.botDisk.pnpmStoreDir` принимает любой путь внутри дерева самого бота (`/workspace`,
  `/data`, `/scratch`, `/bot`); путь в другом месте (в том числе `/cache/...`) отклоняется.
  Сохранённое значение любого из двух прежних умолчаний (`/workspace/.pnpm-store` до 1.6.5,
  `/cache/pnpm-store` 1.6.5–1.6.7) переходит на `/bot/.pnpm-store` с записью в журнал.
- Шаг оператора убран: ни `install -d <sharedPackageCachePath>/pnpm-store`, ни подкаталог
  `packageCacheRoot/pnpm-store` в списке монтирований dockergate и prepare-скриптах; подкаталог
  на хосте, если он есть, просто перестаёт использоваться.
- `/cache/pnpm` остаётся кэшем загрузок (`npm_config_cache_dir`), как и со времён BOT-DISK-D.
- Исполнитель omp по SSH (агенты `omp_local`) закрепляет хранилище внутри своего workspace:
  `npm_config_store_dir=/workspace/.pnpm-store` в `omp-ssh/compose.yml`. Без переменной pnpm
  берёт хранилище из соглашения по cwd и промахивается для команд вне workspace;
  `clone-or-copy` сохраняет работу установок на файловых системах без reflink.
- Тесты: наборы bot-disk-cache, template, docker-driver и profile-compile проверяют новое
  умолчание, отсутствие привязки и миграцию; тесты политик dockergate убирают пару `pnpm-store`.
