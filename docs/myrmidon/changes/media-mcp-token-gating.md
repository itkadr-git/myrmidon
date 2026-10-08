---
divergence-section: Трек 5 — эксплуатация
---

## changelog-en

### The media MCP block joins a bot profile only when the bot has an issued media token; without a token the board shows a «media not connected» attention card instead of HTTP 401 noise (1.6.5 F-11 ч.A)

- Before this change the `media` MCP server (the sidecar of
  `tools/media-mcp`) was on the static per-card MCP list of 31 bots that had
  no issued token, so every media call returned `HTTP 401` — about 1 048 log
  lines an hour across the fleet. The profile compiler now decides per bot
  (`server/src/myrmidon/bot-containers/media-mcp.ts`,
  `profile-compile.ts`): the port `ensureMediaToken` (implemented in
  `profile-ports.ts` through the company secret store, one secret per agent)
  returns the issued token, and only then does the profile get the `media:`
  block in `hermes/config.yaml` plus `MEDIA_TOOLS_TOKEN`, `MEDIA_TOOLS_URL`
  and `MYRMIDON_MCP_TOKEN_MEDIA` in `hermes/.env`. The URL comes from
  `MYRMIDON_MEDIA_MCP_URL` (default `http://media-mcp:8080/mcp`). A media
  server declared statically on a card still wins the name dedup.
- Without a token there is no media block and no media env, so the bot never
  calls the sidecar and the 401 stream stops. Instead the compiler records a
  per-pass «media not connected» signal; the attention feed turns it into one
  card per bot of the new source kind `bot_media_mcp` (severity `warning`,
  ranked below `model_fallback_alert`), cleared automatically as soon as a
  pass issues the token. The bot-side client
  (`tools/media-mcp/bot-scripts/media_client.py`) raises
  `MediaNotConnectedError` before any HTTP request when `MEDIA_TOOLS_TOKEN`
  is empty, and maps an unexpected 401 to the same «media is not connected»
  state — a configuration state, not a runtime error.
- The media service registry (`bots.json`) is now generated from the bots'
  cards: `tools/media-mcp/src/media_mcp/registry.py` turns the exported cards
  into registry entries that name the environment variable holding the bot's
  live token (`token_env`), so the registry file itself stores no credential.
  `config.py` resolves `token_env` to `token_sha256` at load; an entry whose
  variable is unset simply matches no bearer, and bots without tokens are
  never routed by their profiles anyway.

## changelog-ru

### Блок media MCP попадает в профиль бота только при выданном медиа-токене; без токена доска показывает карточку «медиа не подключено» вместо потока HTTP 401 (1.6.5 F-11 ч.A)

- Раньше MCP-сервер `media` (сайдкар `tools/media-mcp`) был в статическом
  списке MCP у 31 бота без выданного токена, и каждый медиа-вызов возвращал
  `HTTP 401` — около 1 048 строк в час на флот. Теперь компилятор профиля
  решает по каждому боту
  (`server/src/myrmidon/bot-containers/media-mcp.ts`, `profile-compile.ts`):
  порт `ensureMediaToken` (реализация в `profile-ports.ts` через секрет-хранилище
  компании, один секрет на агента) возвращает выданный токен, и только тогда в
  профиле появляется блок `media:` в `hermes/config.yaml` и переменные
  `MEDIA_TOOLS_TOKEN`, `MEDIA_TOOLS_URL`, `MYRMIDON_MCP_TOKEN_MEDIA` в
  `hermes/.env`. URL берётся из `MYRMIDON_MEDIA_MCP_URL` (по умолчанию
  `http://media-mcp:8080/mcp`). Статически объявленный на карточке сервер media
  по-прежнему выигрывает дедупликацию по имени.
- Без токена ни блока, ни переменных нет — бот не ходит в сайдкар, и поток 401
  прекращается. Вместо ошибок компилятор записывает на проход сигнал «медиа не
  подключено»; лента внимания превращает его в карточку нового вида
  `bot_media_mcp` (severity `warning`), которая снимается сама, как только на
  проходе появился токен. Клиент на стороне бота
  (`tools/media-mcp/bot-scripts/media_client.py`) при пустом
  `MEDIA_TOOLS_TOKEN` поднимает `MediaNotConnectedError` до любого HTTP-запроса,
  а неожиданный 401 сводит к тому же состоянию «медиа не подключено» — это
  состояние конфигурации, а не ошибка времени выполнения.
- Реестр медиа-сервиса (`bots.json`) генерируется из карточек ботов:
  `tools/media-mcp/src/media_mcp/registry.py` превращает выгруженные карточки в
  записи реестра, где указано имя переменной окружения с живым токеном бота
  (`token_env`), — сам файл реестра учётных данных не хранит. `config.py`
  разрешает `token_env` в `token_sha256` при загрузке; запись с незаданной
  переменной просто не совпадает ни с одним bearer.

## settings-en

- `MYRMIDON_MEDIA_MCP_URL` — URL of the media MCP sidecar the bots' profiles
  point at. Default `http://media-mcp:8080/mcp`. Set it on the board instance
  when the sidecar runs under a different name or port.

## settings-ru

- `MYRMIDON_MEDIA_MCP_URL` — URL медиа-сайдкара MCP, на который ссылаются
  профили ботов. По умолчанию `http://media-mcp:8080/mcp`. Задаётся на
  инстансе доски, если сайдкар запущен под другим именем или портом.
