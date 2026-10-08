---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### Board answers a bot's desired-state poll from a 5-minute cache (1.6.5 BOT-DISK-H LOAD)

- `GET /api/myrmidon/bots/me/workspaces` is polled ~30 times a minute across the
  fleet and every answer used to run the full store pass for the bot (assigned +
  reassigned issues, PR work products, project repo urls, settings). The service
  now caches the built desired state per bot (`companyId + agentId`) in process
  memory for 300 s — the same window as `nextReportSec` the bot is told to
  honor — so a bot costs the board at most one store pass per window. The route
  still serializes every reply (cached value included) through
  `wsDesiredStateSchema`.
- Event invalidation (review fix): TTL alone is not enough. When an issue's
  `status` or `assigneeAgentId` changes, the issue route drops the cached
  desired-state entries of the previous and the next assignee through a
  process-local registry (`bot-workspaces-invalidation.ts`), so the next poll
  rebuilds from the store: a reopened task is back in `protectKeys` at once
  (botd would otherwise archive-delete its directory mid-work), and a
  reassigned task moves between the bots' caches immediately.
- The `enabled` switch is read on every request, uncached: turning the
  mechanism off acts immediately, the reaper stops at the next poll.
- A failed build is not cached; the next request retries. Concurrent pollers
  of one bot collapse into a single store pass.
- `POST /api/myrmidon/bots/me/disk-report` verified to hold no DB await and no
  heavy work beyond validation plus the in-memory map write; no change needed.

## changelog-ru

### Доска отвечает на опрос desired-state бота из кэша на 5 минут (1.6.5 BOT-DISK-H LOAD)

- `GET /api/myrmidon/bots/me/workspaces` опрашивается ~30 раз в минуту по флоту,
  и каждый ответ делал полный проход хранилища по боту (назначенные и
  переназначенные задачи, PR-продукты, url репозиториев проектов, настройки).
  Сервис теперь кэширует собранный desired state по боту (`companyId + agentId`)
  в памяти процесса на 300 с — то же окно, что и `nextReportSec`, — поэтому бот
  стоит доске не больше одного прохода за окно. Маршрут по-прежнему сериализует
  каждый ответ (включая кэшированный) через `wsDesiredStateSchema`.
- Инвалидация по событию (доработка по ревью): одного TTL недостаточно. При
  смене `status` или `assigneeAgentId` задачи маршрут issues сбрасывает
  кэш-записи прежнего и нового исполнителя через процесс-локальный реестр
  (`bot-workspaces-invalidation.ts`), и следующий опрос пересобирает ответ из
  хранилища: переоткрытая задача сразу возвращается в `protectKeys` (иначе
  botd архивирует и удаляет её каталог посреди работы), а переназначенная
  задача сразу переезжает между кэшами ботов.
- Рубильник `enabled` читается на каждый запрос, без кэша: выключение
  действует сразу, сборщик останавливается на следующем опросе.
- Упавшая сборка не кэшируется: следующий запрос повторит. Параллельные
  опросы одного бота схлопываются в один проход хранилища.
- `POST /api/myrmidon/bots/me/disk-report` проверен: в пути нет обращения к БД и
  тяжёлой работы кроме валидации и записи in-memory map; правка не нужна.

## divergence

| BOT-DISK-H4a-INVALIDATE | Кэш desired-state сбрасывается событием: при смене `status` или `assigneeAgentId` задачи PATCH /issues/:id удаляет записи кэша прежнего и нового исполнителя через процесс-локальный реестр; рубильник `enabled` читается на каждый запрос без кэша | `server/src/routes/issues.ts` (импорт и одна точка вызова после записи activity-лога, метка `myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE)`), `server/src/myrmidon/bot-containers/bot-workspaces-service.ts` (регистрация drop-колбэка, `isEnabled` без кэша) + `server/src/myrmidon/bot-containers/bot-workspaces-invalidation.ts` | Кэш на 300 с давал боту устаревший closedKeys после переоткрытия задачи: botd архивировал-удалял каталог задачи, над которой агент снова работает; новое назначение до конца окна отсутствовало в protectKeys. Рубильник, закэшированный на то же окно, не выключал механизм сразу | `server/src/myrmidon/bot-containers/bot-workspaces.myrmidon.test.ts` (блок «desired-state cache invalidation»: переоткрытие и переназначение внутри окна; «isEnabled … acts immediately») | Никогда, наше поведение. При снятии: удалить куски `myrmidon(1.6.5-BOT-DISK-H4a-INVALIDATE)`, модуль `bot-workspaces-invalidation.ts`, блок тестов | [#837](https://github.com/itkadr-git/myrmidon/pull/837) |
