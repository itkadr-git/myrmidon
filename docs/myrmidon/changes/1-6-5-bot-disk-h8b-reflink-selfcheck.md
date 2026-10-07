---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### Bot containers prove at start that pnpm can reflink (1.6.5 BOT-DISK-H, part H8b)

- The container entrypoint replaces the hard-link self-check with a reflink
  self-check: a probe file in the pnpm store is copied with
  `cp --reflink=always` into `/workspace`, `/scratch` and `/data/hermes`. The
  result goes to `${HERMES_HOME}/.myrmidon/reflink-check.json` (the old
  hardlink-check.json format plus `method: "reflink"`). A refusal (EXDEV,
  EOPNOTSUPP) logs an ERROR and raises the `bot_disk_lifecycle/reflink`
  Attention key; the gateway still starts.
- The image CI check is `pnpm-reflink-check.sh`: it installs a fixture package
  offline from every clone root and reports whether the file shares physical
  extents with the store (`filefrag`). A store on another superblock is a
  silent copy; the negative test proves the check sees it, and is skipped with
  its reason where the runner cannot make a second filesystem.

## changelog-ru

### Контейнер бота при старте доказывает, что pnpm умеет reflink (1.6.5 BOT-DISK-H, часть H8b)

- Entrypoint вместо проверки жёстких ссылок делает проверку reflink: пробный
  файл из хранилища pnpm копируется `cp --reflink=always` в `/workspace`,
  `/scratch` и `/data/hermes`. Результат — `${HERMES_HOME}/.myrmidon/reflink-check.json`
  (формат hardlink-check.json плюс `method: "reflink"`). Отказ (EXDEV,
  EOPNOTSUPP) пишет ERROR и поднимает ключ карточки `bot_disk_lifecycle/reflink`;
  шлюз всё равно стартует.
- В CI образа проверку делает `pnpm-reflink-check.sh`: ставит тестовый пакет
  офлайн из каждого корня клонов и смотрит, делит ли файл физические экстенты
  с хранилищем (`filefrag`). Хранилище на другом суперблоке — тихая копия;
  негативный тест это ловит, а где раннер не может создать вторую ФС — тест
  пропускается с причиной.
