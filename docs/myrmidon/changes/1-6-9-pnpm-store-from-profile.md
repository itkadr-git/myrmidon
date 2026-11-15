## changelog-en

### The pnpm store from the bot profile now wins over the image default (OPE-13112)

- The board setting `general.botDisk.pnpmStoreDir` (`/cache/pnpm-store`) was written into the bot's `.env`, but processes of the bot still saw the image default `npm_config_store_dir=/workspace/.pnpm-store`, so `pnpm store path` and every install used a per-bot store instead of the shared one. The `pnpm` wrapper now reads `npm_config_store_dir` from `${HERMES_HOME}/.env` and uses it when it is an absolute path the bot can write to (the directory, or for a missing one its nearest existing parent).
- If the profile sets nothing, or the directory is not writable, nothing changes: the store stays `/workspace/.pnpm-store`.

## changelog-ru

### Склад pnpm из профиля бота теперь важнее умолчания образа (OPE-13112)

- Настройка доски `general.botDisk.pnpmStoreDir` (`/cache/pnpm-store`) попадала в `.env` бота, но процессы бота по-прежнему видели умолчание образа `npm_config_store_dir=/workspace/.pnpm-store`, поэтому `pnpm store path` и любая установка шли в свой склад бота, а не в общий. Обёртка `pnpm` теперь читает `npm_config_store_dir` из `${HERMES_HOME}/.env` и берёт его, если это абсолютный путь, доступный боту на запись (сам каталог или, для ещё не созданного, ближайший существующий родитель).
- Если профиль ничего не задаёт или каталог недоступен на запись, ничего не меняется: склад остаётся `/workspace/.pnpm-store`.
