---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
settings-section: 1.6.1 — BOT-DISK B: shared package cache for bot containers
---

## changelog-en

### The bot runtime is mounted read-only from one copy on the host (1.6.5 BOT-DISK-H, part H11)

- New instance setting `general.botDisk.sharedBotRuntimePath`: an absolute host
  directory whose `bin`, `lazy-packages` and `lsp` subdirectories every bot on
  the default host mounts read-only over its own runtime paths — one host copy
  instead of one per bot (5–7 GiB per copy on the production fleet). Unset (the
  default) keeps today's behaviour: every bot has its own copies. Changed on the
  Instance → General page or via `PATCH /api/myrmidon/bot-disk`; the next
  reconcile pass applies it, without a restart.
- The three read-only binds land at the real path inside the bot's own mount:
  `/bot/hermes/{bin,lazy-packages,lsp}` for a single-layout bot,
  `/bot-scope/<botKey>/hermes/…` for a member of a shared isolation scope, and
  `/data/hermes/…` for a contract-`1` (legacy three-bind) image.
- A bot card may mount an allowlisted host directory read-only at a path inside
  the bot's own tree, but only under `/data/hermes/.hermes/shared`,
  `/data/hermes/media` or `/data/hermes/work` (epic design, class J); the board
  binds it at that subtree's real path inside the bot's tree. Every other
  reserved path — the three runtime paths included — is still refused, so a card
  can neither shadow the shared runtime nor write into it.
- dockergate: `botRuntimeRoot` in its configuration (the same path; unset
  accepts no runtime bind) and the class J mount points.

## changelog-ru

### Среда ботов монтируется на чтение из одной копии на хосте (1.6.5 BOT-DISK-H, часть H11)

- Новая настройка экземпляра `general.botDisk.sharedBotRuntimePath`: абсолютный
  каталог хоста, подкаталоги `bin`, `lazy-packages` и `lsp` которого каждый бот
  хоста по умолчанию монтирует на чтение поверх своих путей среды — одна копия
  на хосте вместо копии на каждого бота (5–7 ГиБ на копию на боевом парке). Не
  задано (по умолчанию) — прежнее поведение: у каждого бота свои копии.
  Меняется на странице Инстанс → Общие или через `PATCH /api/myrmidon/bot-disk`;
  следующий проход сверки применяет значение без перезапуска.
- Три привязки на чтение попадают на настоящий путь внутри единого монтирования
  бота: `/bot/hermes/{bin,lazy-packages,lsp}` — для бота с единым
  монтированием, `/bot-scope/<botKey>/hermes/…` — для участника общей области
  изоляции, `/data/hermes/…` — для образа с контрактом `1` (три привязки).
- Карточка бота может смонтировать разрешённый каталог хоста на чтение по пути
  внутри дерева бота, но только под `/data/hermes/.hermes/shared`,
  `/data/hermes/media` или `/data/hermes/work` (класс J проекта эпика); доска
  привязывает его по настоящему пути этого поддерева внутри дерева бота. Любой
  другой занятый путь — три пути среды в том числе — по-прежнему отклоняется,
  поэтому карточка не может ни подменить общую среду, ни писать в неё.
- dockergate: ключ `botRuntimeRoot` в конфигурации (тот же путь; не задан — ни
  одна привязка среды не принимается) и точки монтирования класса J.
## settings-en

| `general.botDisk.sharedBotRuntimePath` | 1.6.5-BOT-DISK-H11 | unset (every bot has its own runtime) | Absolute host directory whose `bin`, `lazy-packages` and `lsp` subdirectories every bot on the default host mounts read-only over its own runtime paths in the container (`/bot/hermes/…`), so one host copy replaces one copy per bot (5–7 GiB per copy on the production fleet). The board adds the three binds itself and checks them against the mounts of a card: a card cannot take one of the three paths over. Applies on the next reconcile pass, no restart. Bots on a fleetd host are not affected (logged once) | `null` or empty — off (every bot keeps its own copies). **Operator step:** create the three subdirectories, move one bot's `bin`, `lazy-packages` and `lsp` from its volume into them (they are the same files for every bot), own them by the image's user (uid/gid 10001) and set the same directory as `botRuntimeRoot` in the dockergate configuration ([dockergate.md](dockergate.md)), otherwise every runtime bind is refused with `mount_source_not_allowed`. Do not delete a bot's own copies before the setting is saved. See [bot-extra-mounts.md](bot-extra-mounts.md) |

## settings-ru

| `general.botDisk.sharedBotRuntimePath` | 1.6.5-BOT-DISK-H11 | не задано (у каждого бота своя среда) | Абсолютный каталог хоста, подкаталоги `bin`, `lazy-packages` и `lsp` которого каждый бот хоста по умолчанию монтирует на чтение поверх своих путей среды в контейнере (`/bot/hermes/…`), так что одна копия на хосте заменяет копию на каждого бота (5–7 ГиБ на копию на боевом парке). Три привязки доска добавляет сама и сверяет с монтированиями карточки: занять один из трёх путей карточка не может. Действует со следующего прохода сверки, без перезапуска. Боты на хосте fleetd не затронуты (одна запись в журнале) | `null` или пусто — выключено (у каждого бота свои копии). **Шаг оператора:** создать три подкаталога, перенести в них `bin`, `lazy-packages` и `lsp` одного бота из его тома (это одни и те же файлы у всех ботов), выставить владельца — пользователя образа (uid/gid 10001) — и задать тот же каталог как `botRuntimeRoot` в конфигурации dockergate ([dockergate.ru.md](dockergate.ru.md)), иначе каждая привязка среды отклоняется с `mount_source_not_allowed`. Не удалять собственные копии бота до сохранения настройки. См. [bot-extra-mounts.ru.md](bot-extra-mounts.ru.md) |

## divergence

| 1.6.5-BOT-DISK-H11 | Настройка `general.botDisk.sharedBotRuntimePath` и три привязки на чтение (`bin`, `lazy-packages`, `lsp`) из одной копии на хосте, на настоящем пути внутри единого монтирования бота (участник области — `/bot-scope/<botKey>/hermes/…`, контракт `1` — `/data/hermes/…`). Точки монтирования класса J (`/data/hermes/.hermes/shared`, `/data/hermes/media`, `/data/hermes/work`) становятся единственными путями внутри тома, которые карточка может занять, и тоже привязываются по настоящему пути. dockergate получает ключ `botRuntimeRoot` и то же исключение | Наши файлы: `packages/shared/src/myrmidon-bot-disk.ts` (схема, нормализация, `BotDiskLayout`, `resolveSharedBotRuntimePath`), `server/src/myrmidon/bot-containers/template.ts` (`BOT_RUNTIME_MOUNTS`, `BOT_OWNER_DATA_CONTAINER_ROOTS`, `botTreeRealPath`, сами привязки и проверка монтирований), `docker-driver.ts` (чтение настройки в контекст шаблона), `bot-disk-service.ts` (`readSharedBotRuntimePath`), `startup.ts` (проброс), `tools/dockergate/internal/policy/create.go` (`BotRuntimeMounts`, `OwnerDataContainerRoots`, `botTreeTarget`, `botTreeContainerPath`), `tools/dockergate/internal/config/config.go` (ключ `botRuntimeRoot`), `tools/dockergate/internal/gate/routes.go` (проброс в политику) и тесты `template.myrmidon.test.ts`, `create_test.go`, `config_test.go`. Маркеров вендора нет: все файлы наши | Владелец согласовал перемонтирование раздела с prjquota в окне выката rc.5; без общей среды собственные копии ботов `bin`, `lazy-packages` и `lsp` занимают 5–7 ГиБ на бота, а ручная чистка томов запрещена. Требование тикета OPE-5318 (часть H11 проекта) | `template.myrmidon.test.ts` (три пары и их порядок, единое монтирование / участник области / контракт `1`, отказ негодного пути, отказ карточке занять путь среды, класс J на настоящем пути и отказ вне трёх корней), `create_test.go` (три пары приняты и тело не переписано; без `botRuntimeRoot`, из-под другого корня, с другой точкой монтирования или на запись — `mount_source_not_allowed`; класс J внутри дерева принят, вне трёх корней — `binds_mismatch`), `config_test.go` (форма `botRuntimeRoot` и пересечения с корнем томов и областью) | Никогда, наше поведение. Снятие: удалить блок `myrmidon(1.6.5-BOT-DISK-H11)`, `BOT_RUNTIME_MOUNTS`, `BOT_OWNER_DATA_CONTAINER_ROOTS` и `botTreeRealPath` из шаблона, `BotRuntimeMounts`, `OwnerDataContainerRoots`, `botTreeTarget` и `botTreeContainerPath` из dockergate, ключ `sharedBotRuntimePath` из схемы, `BotDiskLayout` и проброс в драйвер, ключ `botRuntimeRoot` из конфигурации dockergate, три теста и фрагмент доков | (этот PR) |
