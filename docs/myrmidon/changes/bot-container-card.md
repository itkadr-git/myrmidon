---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### Container bot cards are complete, and the image rollout names every bot (1.6.4-BOT-CONTAINER-CARD)

- Migration `0299_bot_container_card_complete`: every agent whose card has an
  `adapterConfig.container` block gets `enabled: true` when it is absent and the
  product defaults for any missing limit (`memoryMb` 2048, `cpus` 1, `pidsLimit`
  512 — the card form's defaults; one set for every bot image family). Values
  already on the card win, including `enabled: false`. Before it, such cards were
  refused at apply (`container.enabled is not true`, then `container.memoryMb must
  be a positive number`) and skipped by the release bot-image rollout.
- Saving a `hermes_gateway` card with a `container` block that has no `enabled`,
  or is enabled without positive `memoryMb`/`cpus`/`pidsLimit`, is refused with
  422 and a message naming the missing fields and the defaults. In the card the
  Container section shows the fields of such a legacy block and says what is
  missing; turning it on fills the limits.
- The bot-container status API (`GET /api/myrmidon/agents/:id/bot-container/status`)
  carries `imageTracking`: `tracks_release`, `pinned` (with the pinned image) or
  `not_applicable` (with the reason); the card shows it. The bot-image rollout
  (`bot-image-rollout.sh`) reports every container bot in one of these categories:
  it logs and journals each pinned and not applicable bot, prints the count of
  each, and writes `pinnedBots` / `notApplicableBots` and `notApplicable` into its
  summary. Its card PATCH now sends the whole `container` block with the new image
  (the board merges `adapterConfig` one level deep, so an image-only patch dropped
  `enabled` and the limits).
- Clone-hygiene reports are collected per bot: the sweep takes the bots from the
  agent cards and asks the runtime about each by name (inspect, then the report
  read). The earlier container listing (`GET /containers/json`) is on dockergate's
  closed list and answered 403 on every sweep, so no report was ever collected. The
  driver's `list` now takes the bot keys.
- dockergate gets one narrow read-only route, A13: `GET .../myrmidon-bot-<K>/archive?path=<clone-hygiene report>`
  (one fixed file of the main container, like the applied-state marker A3); the
  report read was refused too. No other route changed.
- Contract test board <-> dockergate: every Docker API path in the board driver's
  request sites must be allowed by the route table
  (`tools/dockergate/contract/testdata/allowed-routes.json`, kept equal to the Go
  route parser by a Go test); it fails on a container listing.

## changelog-ru

### Карточки контейнерных ботов полные, а раскатка образа называет каждого бота (1.6.4-BOT-CONTAINER-CARD)

- Миграция `0299_bot_container_card_complete`: у каждого агента, чья карточка
  содержит блок `adapterConfig.container`, `enabled` становится `true`, если его
  нет, а недостающие лимиты берут умолчания продукта (`memoryMb` 2048, `cpus` 1,
  `pidsLimit` 512 — умолчания формы карточки; один набор на все семейства образов
  ботов). Значения, уже стоящие в карточке, главнее, включая `enabled: false`. Раньше
  такие карточки отклонялись при применении (`container.enabled is not true`, затем
  `container.memoryMb must be a positive number`) и пропускались раскаткой образа
  ботов релиза.
- Сохранение карточки `hermes_gateway` с блоком `container` без `enabled` или с
  `enabled: true`, но без положительных `memoryMb`/`cpus`/`pidsLimit`, отклоняется с
  422 и сообщением, которое называет недостающие поля и умолчания. В карточке секция
  «Container» показывает поля такого старого блока и говорит, чего не хватает;
  включение заполняет лимиты.
- API состояния контейнера бота (`GET /api/myrmidon/agents/:id/bot-container/status`)
  отдаёт `imageTracking`: `tracks_release` (идёт за релизом), `pinned` (закреплён, с
  образом) или `not_applicable` (не применимо, с причиной); карточка показывает это.
  Раскатка образа ботов (`bot-image-rollout.sh`) относит каждого контейнерного бота
  к одной из категорий: пишет в журнал и в лог каждого закреплённого и неприменимого,
  печатает счётчики и кладёт `pinnedBots` / `notApplicableBots` / `notApplicable` в
  сводку. PATCH карточки теперь отправляет блок `container` целиком с новым образом
  (доска сливает `adapterConfig` на один уровень, поэтому патч из одного образа
  стирал `enabled` и лимиты).
- Отчёты гигиены клонов собираются по ботам: проход берёт ботов из карточек агентов и
  спрашивает среду по имени каждого (инспекция, затем чтение отчёта). Прежний листинг
  контейнеров (`GET /containers/json`) стоит в закрытом списке dockergate и на каждом
  проходе получал 403, поэтому ни один отчёт не собирался. `list` драйвера теперь
  принимает ключи ботов.
- В dockergate добавлен один узкий маршрут только на чтение, A13:
  `GET .../myrmidon-bot-<K>/archive?path=<отчёт гигиены клонов>` (один фиксированный
  файл основного контейнера, как маркер A3); чтение отчёта тоже отклонялось. Других
  маршрутов не менялось.
- Контрактный тест доска <-> dockergate: каждый путь Docker API в местах запросов
  драйвера доски должен разрешаться таблицей маршрутов
  (`tools/dockergate/contract/testdata/allowed-routes.json`, её равенство разборщику
  маршрутов на Go держит тест на Go); тест падает на листинге контейнеров.

## divergence

| 1.6.4-BOT-CONTAINER-CARD | Сохранение карточки `hermes_gateway` с блоком `container` без `enabled` или с `enabled: true` без положительных `memoryMb`/`cpus`/`pidsLimit` отклоняется 422 с названием полей и умолчаний; миграция `0299` дополняет такие карточки (умолчания продукта 2048/1/512); API состояния контейнера отдаёт `imageTracking` (идёт за релизом / закреплён / не применимо), раскатка образа ботов называет каждого бота и шлёт PATCH блока целиком; отчёты гигиены клонов собираются по ботам из карточек, без листинга контейнеров. Вендорский путь сохранения карточки получает один вызов-сторож | `server/src/routes/agents.ts` (импорт + один вызов в `assertAdapterConfigConstraints`, метки `myrmidon(1.6.4-BOT-CONTAINER-CARD)`) + наши `server/src/myrmidon/bot-containers/{agent-config,routes,bot-disk-service,docker-driver,fleetd-driver,fleetd-routing,driver}.ts`, `ui/src/components/myrmidon/`, `scripts/myrmidon/deploy/bot-image-rollout.sh`, `tools/dockergate` (маршрут A13) | 48 из 74 контейнерных карточек не имели `enabled` и лимитов: применение отвечало 409, раскатка образа молча пропускала их; закреплённые боты не показывались; листинг контейнеров получал 403 от dockergate, и отчёты гигиены клонов не собирались | `server/src/myrmidon/bot-containers/agent-config.myrmidon.test.ts`, `server/src/myrmidon/bot-containers/dockergate-contract.myrmidon.test.ts`, `server/src/__tests__/agent-adapter-validation-routes.test.ts` (тест «refuses a hermes_gateway container block…»), `packages/db/src/bot-container-card-migration.myrmidon.test.ts` | Никогда, наше поведение. Удалить вызов-сторож и импорт в `routes/agents.ts`; остальное — наши модули | (этот PR) |
