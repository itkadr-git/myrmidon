## changelog-en

### Board answers a bot's desired-state poll from a 5-minute cache (1.6.5 BOT-DISK-H LOAD)

- `GET /api/myrmidon/bots/me/workspaces` is polled ~30 times a minute across the
  fleet and every answer used to run the full store pass for the bot (assigned +
  reassigned issues, PR work products, project repo urls, settings). The service
  now caches the built desired state per bot (`companyId + agentId`) in process
  memory for 300 s — the same window as `nextReportSec` the bot is told to
  honor — so a bot costs the board at most one store pass per window. The route
  still serializes every reply (cached value included) through
  `wsDesiredStateSchema`. The `enabled` gate in front of the route is cached
  with the same window.
- No event invalidation by design: the 5-minute slack is contract-safe (`closing`
  holds 14 days, a woken bot receives SIGUSR1 from its run anyway). A failed
  build is not cached; the next request retries. Concurrent pollers of one bot
  collapse into a single store pass.
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
  каждый ответ (включая кэшированный) через `wsDesiredStateSchema`. Фронт-гейт
  `enabled` кэшируется на то же окно.
- Инвалидация по событиям не делается намеренно: люфт в 5 минут безопасен по
  контракту (`closing` держится 14 дней, просыпающийся бот получает SIGUSR1 от
  прогона). Упавшая сборка не кэшируется: следующий запрос повторит. Параллельные
  опросы одного бота схлопываются в один проход хранилища.
- `POST /api/myrmidon/bots/me/disk-report` проверен: в пути нет обращения к БД и
  тяжёлой работы кроме валидации и записи in-memory map; правка не нужна.
