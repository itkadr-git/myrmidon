---
divergence-section: 1.6.1 — BOT-DISK B: общий кэш пакетов для контейнеров ботов
---

## changelog-en

### One mount per bot container, hard-linked node_modules (BOT-DISK-D)

- A bot container has one bind for its writable data: `<volume root>/<bot key>`
  at `/bot`, with `hermes/`, `workspace/` and `scratch/` inside; `/data/hermes`,
  `/workspace` and `/scratch` are links made by the image. link(2) cannot cross a
  mount point, so with three binds (and the pnpm store on a fourth) every `pnpm
  install` silently copied each package into each clone and a bot's disk grew
  ~5 GB per hour. The host layout is unchanged; helper containers keep their
  three narrow binds; dockergate accepts the single-bind body (deploy dockergate
  and the board together, as in ONE-DEPLOY).
- The pnpm store lives inside the mount (`/workspace/.pnpm-store`) and pnpm runs
  with `package-import-method=hardlink`. pnpm 9 still copies silently when the
  kernel refuses a link, so the guard is the start-time self-check, not pnpm.
  `/cache/pnpm` stays a download cache only. Settings `general.botDisk.pnpmStoreDir`
  and `pnpmImportMethod` replace `pnpmStore` (`workspace`/`shared`), applied on
  the next reconcile pass (Instance -> General).
- Every container start checks that a hard link from the store into
  `/data/hermes`, `/workspace` and `/scratch` works; a failure is logged and
  shown as an attention card (`bot_disk_lifecycle`) via the clone-hygiene report.
  The image build checks all three roots and the repository test runs the script.
- Migrating running bots: [bot-disk-cache.md](../bot-disk-cache.md#migrating-running-bots-to-the-single-mount).
  Removed: the `pnpmStore` key (a stored value is ignored) and its `shared` mode.

## changelog-ru

### Одно монтирование на контейнер бота, node_modules на жёстких ссылках (BOT-DISK-D)

- У контейнера бота теперь **одна** привязка для записываемых данных:
  `<корень томов>/<ключ бота>` в `/bot`, внутри `hermes/`, `workspace/` и `scratch/`.
  `/data/hermes`, `/workspace` и `/scratch` — ссылки, которые образ делает внутрь неё.
  link(2) не пересекает точку монтирования даже на одной файловой системе ext4, поэтому
  при трёх отдельных привязках (и хранилище pnpm на четвёртой) каждый `pnpm install`
  молча копировал каждый пакет в каждый клон, и диск бота рос примерно на 5 ГБ в час.
  Раскладка на хосте не меняется; контейнеры-помощники сохраняют три узкие привязки;
  dockergate принимает тело бота с единой привязкой (dockergate и доску выкатывать
  вместе, как в ONE-DEPLOY).
- Хранилище pnpm лежит внутри этого монтирования (по умолчанию `/workspace/.pnpm-store`),
  а pnpm запускается с `package-import-method=hardlink`. Важно: pnpm 9 всё равно молча
  копирует, когда ядро отказывает в ссылке, при любом способе, поэтому защита —
  самопроверка при запуске ниже, а не pnpm. `/cache/pnpm` остаётся только кэшем загрузок
  (метаданных). Настройки `general.botDisk.pnpmStoreDir` и `pnpmImportMethod` заменяют
  `pnpmStore` (`workspace`/`shared`); применяются на следующем проходе сверки без
  перезапуска (Instance → General).
- При каждом старте контейнер проверяет, что жёсткая ссылка из хранилища в
  `/data/hermes`, `/workspace` и `/scratch` создаётся; сбой пишется в журнал и
  показывается на доске карточкой внимания (источник `bot_disk_lifecycle`) через отчёт
  гигиены клонов. Сборка образа проверяет все три корня, тот же скрипт запускает тест
  репозитория.
- Перевод работающих ботов (пауза, пересоздание с новым монтированием, проверка,
  возобновление) — в [bot-disk-cache.ru.md](../bot-disk-cache.ru.md#перевод-работающих-ботов-на-единое-монтирование).
  Удалено: прежний ключ `pnpmStore` (сохранённое значение игнорируется) и его режим
  `shared`.

## divergence

| BOT-DISK-D | Контейнер бота получает ОДНУ привязку `<корень>/<ключ>:/bot` вместо трёх (`hermes`, `workspace`, `scratch`); `/data/hermes`, `/workspace`, `/scratch` — ссылки образа внутрь неё (`BOT_ROOT_MOUNT` в `template.ts`, `buildBinds`; помощники — `buildHelperBinds`, три узкие привязки). Хранилище pnpm внутри монтирования (`pnpmStoreDir`, по умолчанию `/workspace/.pnpm-store`), `package-import-method=hardlink` (`pnpmImportMethod`), `/cache/pnpm` — только кэш загрузок; ключ `pnpmStore` удалён. Самопроверка жёстких ссылок в точке входа → `hardlink-check.json` → отчёт гигиены клонов → карточка внимания; `pnpm-hardlink-check.sh` проверяет три корня. dockergate: тело бота с привязкой `BotBind`, маркер читается по `/bot/hermes/...`, `/bot` и `/data` зарезервированы | Вендорские файлы не тронуты; `server/src/myrmidon/bot-containers/{template,docker-driver,profile-compile,profile-ports,clone-hygiene}.ts`, `packages/shared/src/myrmidon-bot-disk.ts`, `docker/bot-runtime/{Dockerfile,entrypoint.sh,pnpm-hardlink-check.sh,git-reference/bot-clone-hygiene}`, `tools/dockergate/internal/{policy,route,gate}`, `ui/src/components/myrmidon/BotDiskSettingsPanel.tsx` | Жёсткая ссылка не пересекает точку монтирования даже на одной ext4: при трёх привязках pnpm молча копировал пакеты в каждый клон, диск бота рос ~5 ГБ/ч | `server/src/myrmidon/bot-containers/bot-disk-cache.myrmidon.test.ts`, `docker-driver.myrmidon.test.ts`, `clone-hygiene.myrmidon.test.ts`, `scripts/myrmidon/bot-runtime/{pnpm-hardlink,entrypoint,dockerfile}.test.mjs`, `tools/dockergate/internal/policy/create_test.go` | Никогда, наше поведение. Вендорских аналогов нет | (этот PR) |
