## changelog-en

### fleetd on a remote site: a safe marker read, the same container template, writable caches

- A bot can no longer stall or exhaust fleetd through its applied marker. fleetd runs as root and
  reads `hermes/.myrmidon/applied.json` from a directory the bot owns. It now opens the file without
  following a symlink and without blocking, accepts only a regular file, and reads at most 64 KiB.
  A symlink, a FIFO, a directory or a larger file counts as "no marker".
- A container on a remote site now gets the template of the board host: `/tmp` as a tmpfs, an init
  process, the `on-failure` restart policy, and `MemorySwap` equal to `Memory`. A container that
  exists already gets the template at its next recreate.
- fleetd refuses a spec with `cpus` below 0.01 (a tiny value used to round to "no CPU limit"), with
  a `gatewayPort` outside 1024-65535, or with a `boardExtraHost` that differs from the site's own.
  The answer is `spec_invalid`. The board address in a container always comes from the site
  configuration.
- New configuration key `writableMountRoots` (default: empty). An extra mount without `readOnly` is
  accepted only when its source, with symlinks resolved, is inside one of these directories (and
  inside `allowedMounts`). Work bots can use their shared package caches on a remote site. Roll out
  the new binary before the configuration that uses the key.

## changelog-ru

### fleetd на удалённой площадке: безопасное чтение маркера, тот же шаблон контейнера, записываемые кэши

- Бот больше не может подвесить fleetd или съесть его память через свой маркер применённого
  профиля. fleetd работает от root и читает `hermes/.myrmidon/applied.json` из каталога, которым
  владеет бот. Теперь файл открывается без перехода по симлинку и без блокировки, принимается
  только обычный файл, читается не больше 64 КиБ. Симлинк, FIFO, каталог и файл больше лимита
  считаются отсутствием маркера.
- Контейнер на удалённой площадке теперь создаётся по шаблону хоста доски: `/tmp` в tmpfs,
  init-процесс, политика перезапуска `on-failure`, `MemorySwap` равен `Memory`. Уже созданный
  контейнер получит шаблон при следующем пересоздании.
- fleetd отклоняет spec с `cpus` меньше 0.01 (малое значение раньше округлялось до «без лимита
  CPU»), с `gatewayPort` вне 1024-65535 и с `boardExtraHost`, не совпадающим с адресом самой
  площадки. Ответ — `spec_invalid`. Адрес доски в контейнере всегда берётся из конфигурации
  площадки.
- Новый ключ конфигурации `writableMountRoots` (по умолчанию пусто). Дополнительный монт без
  `readOnly` принимается, только если его источник (с раскрытыми симлинками) лежит внутри одного из
  этих каталогов (и внутри `allowedMounts`). Боты work могут использовать общие кэши пакетов на
  удалённой площадке. Сначала выкатывайте новый бинарник, потом конфигурацию с этим ключом.
