---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### Bot containers prove at start that the shared uv cache can clone (1.6.5 BOT-DISK-UV, part B)

- The container entrypoint runs a uv cache self-check at every start: a probe
  file in `UV_CACHE_DIR` is copied with `cp --reflink=always` into
  `/data/hermes`, `/workspace` and `/scratch`; where `filefrag` is available
  the result is confirmed by shared physical extents. For `UV_LINK_MODE=hardlink`
  the probe checks the inode instead (`stat -c %i`), because a hard link is the
  success case there and a reflink proof would report the opposite.
- The result goes to `${HERMES_HOME}/.myrmidon/uv-cache-check.json`
  (`method` = the uv link mode, same shape as reflink-check.json: `version`,
  `checkedAt`, `cache`, `ok`, `roots[]`). A refusal or a silent full copy logs
  an ERROR and does not stop the gateway: a bot with a broken shared cache
  works, it just wastes space and traffic (same logic as the pnpm check).
- The check is gated by `MYRMIDON_UV_CHECK` (the entrypoint reads it from the
  bot's `hermes/.env` first, then the process environment; default `1`) and
  its roots by `MYRMIDON_UV_CHECK_ROOTS`. The cache keys
  (`general.botDisk.uvCacheDir`, `general.botDisk.uvLinkMode`) are documented
  by part A.

## changelog-ru

### Контейнер бота при старте доказывает, что общий кэш uv умеет clone (1.6.5 BOT-DISK-UV, часть B)

- Entrypoint при каждом старте делает самопроверку кэша uv: пробный файл из
  `UV_CACHE_DIR` копируется `cp --reflink=always` в `/data/hermes`, `/workspace`
  и `/scratch`; где есть `filefrag` — успех подтверждается общими физическими
  экстентами. Для `UV_LINK_MODE=hardlink` пробер проверяет вместо экстентов
  inode (`stat -c %i`): там успех — это жёсткая ссылка, а reflink-доказательство
  показало бы обратное.
- Результат — `${HERMES_HOME}/.myrmidon/uv-cache-check.json` (`method` = link
  mode uv, формат как reflink-check.json: `version`, `checkedAt`, `cache`,
  `ok`, `roots[]`). Отказ или тихая полная копия пишут ERROR и не останавливают
  шлюз: бот с битым общим кэшем работает, просто расточителен (та же логика,
  что у проверки pnpm).
- Проверку включают/выключают `MYRMIDON_UV_CHECK` (entrypoint читает его сначала
  из `hermes/.env` бота, потом из окружения процесса; по умолчанию `1`) и
  `MYRMIDON_UV_CHECK_ROOTS` — список корней. Ключи настроек
  (`general.botDisk.uvCacheDir`, `general.botDisk.uvLinkMode`) задокументированы
  частью A.

## divergence

| 1.6.5-BOT-DISK-UV-B | Самопроверка общего кэша uv при старте контейнера бота (`uv-cache-check.json`, `method` = link mode uv; reflink+extents для `clone`/`copy`, inode для `hardlink`), ERROR без остановки шлюза, гейты `MYRMIDON_UV_CHECK`/`MYRMIDON_UV_CHECK_ROOTS` | Наши файлы: `docker/bot-runtime/entrypoint.sh`, `scripts/myrmidon/bot-runtime/entrypoint.test.mjs`, документ `docs/myrmidon/bot-disk-cache.md` (+ru). Маркеров вендора нет: все файлы наши. Часть A (настройки, привязка `/cache/uv`, `UV_CACHE_DIR`/`UV_LINK_MODE` в профиле) слита в `rel/1.6.5-rc.7` отдельным PR — OPE-5827 | Требование тикета OPE-5825 (часть B): тихая копия вместо clone на чужом суперблоке съедает диск и трафик молча; проверка при старте делает это видимым, как reflink-самопроверка pnpm (BOT-DISK-H8b) | `entrypoint.test.mjs` (успех clone — `ok:true` и экстенты; отказ `cp` EXDEV/EOPNOTSUPP — ERROR и `ok:false`, шлюз стартует; `hardlink` — проверка inode; пустой кэш — `ok:true, reason=empty`; битый кэш не пишет файл и не роняет старт) | Никогда, наше поведение. Снятие: удалить секцию `uv cache self-check` из entrypoint | (этот PR) |
