---
divergence-section: Трек 5 — эксплуатация
settings-section: Track 5 — operations
---

## changelog-en

### The media MCP block joins a bot profile only when the bot's card carries a media token; without one the board shows a «media not connected» attention card instead of HTTP 401 noise (1.6.5 F-11 ч.A)

- Before this change the `media` MCP server (the sidecar of `tools/media-mcp`)
  was on the static per-card MCP list of 31 bots that had no token, so every
  media call returned `HTTP 401` — about 1 048 log lines an hour across the
  fleet. The profile compiler now decides per bot
  (`server/src/myrmidon/bot-containers/media-mcp.ts`, `profile-compile.ts`)
  on the single token source: the card env entry `MEDIA_TOOLS_TOKEN`
  (`mediaTokenFromEnv`, the frozen MEDIA-PROVISION contract of
  `media-acl-export.ts` — the same entry the board-side exporter hashes into
  the facade's `bots.json`). When the entry resolves non-empty, the profile
  gets the `media:` block in `hermes/config.yaml` plus `MEDIA_TOOLS_URL` in
  `hermes/.env`; the token itself travels in the card env, so the compiler
  never writes or resolves a second secret. The URL comes from
  `MYRMIDON_MEDIA_MCP_URL` (default `http://media-mcp:8080/mcp`).
- A statically declared `media` MCP server (a card's or the instance-wide
  `MYRMIDON_BOT_MCP_SERVERS`) no longer survives a missing card token: the
  compiler filters the name out and the compiled profile has no `media`
  server at all. Operators should still remove the static entry from the
  settings — until then the filter is what stops the 401 flood.
- Without a token there is no media block and no media env, so the bot never
  calls the sidecar and the 401 stream stops. Instead the compiler records a
  per-pass «media not connected» signal; the attention feed turns it into one
  card per bot of the new source kind `bot_media_mcp` (severity `low`,
  advisory rank 13 — one step below `model_fallback_alert` (medium)), cleared automatically as
  soon as a pass sees the token. The bot-side client
  (`tools/media-mcp/bot-scripts/media_client.py`) raises
  `MediaNotConnectedError` before any HTTP request when `MEDIA_TOOLS_TOKEN`
  is empty and the bot is not in peer-auth mode, and maps an unexpected 401
  to the same «media is not connected» state — a configuration state, not a
  runtime error.
- Peer-auth bots keep working, but they lose the `media` MCP block too: the
  block is emitted only when the card carries a bearer token
  (`MEDIA_TOOLS_TOKEN`). A bot that authenticates to the facade by `peer_host`
  (auth.py, `config.example.json`) sets `MEDIA_TOOLS_PEER_AUTH=1` in its card
  env — it calls the facade directly (its scripts already know the endpoint),
  without a bearer token; the client then sends no Authorization header and
  does not raise. `MEDIA_TOOLS_PEER_AUTH` only affects the bot-side client;
  the compiler does not read it and no `media` block is emitted either way.
- The media service registry (`bots.json`) has exactly one owner: the
  board-side exporter of MEDIA-PROVISION (`media-acl-export.ts`), which
  rewrites it from the cards and stores sha256 digests. The compiler and the
  bot scripts consume the registry's contract; no second generator exists.

## changelog-ru

### Блок media MCP попадает в профиль бота, только если на карточке бота есть медиа-токен; без него доска показывает карточку «медиа не подключено» вместо потока HTTP 401 (1.6.5 F-11 ч.A)

- Раньше MCP-сервер `media` (сайдкар `tools/media-mcp`) был в статическом
  списке MCP у 31 бота без токена, и каждый медиа-вызов возвращал `HTTP 401` —
  около 1 048 строк в час на флот. Теперь компилятор профиля решает по
  каждому боту (`server/src/myrmidon/bot-containers/media-mcp.ts`,
  `profile-compile.ts`) по единственному источнику токена: записи env
  карточки `MEDIA_TOOLS_TOKEN` (`mediaTokenFromEnv`, замороженный контракт
  MEDIA-PROVISION из `media-acl-export.ts` — ту же запись бордовый экспортёр
  хеширует в `bots.json` фасада). Если запись непуста, в профиле появляется
  блок `media:` в `hermes/config.yaml` и `MEDIA_TOOLS_URL` в `hermes/.env`;
  сам токен едет в env карточки — компилятор не создаёт и не разрешает второй
  секрет. URL берётся из `MYRMIDON_MEDIA_MCP_URL` (по умолчанию
  `http://media-mcp:8080/mcp`).
- Статически объявленный сервер `media` (на карточке или в инстансовом
  `MYRMIDON_BOT_MCP_SERVERS`) больше не переживает отсутствие токена на
  карточке: компилятор вырезает имя, и в скомпилированном профиле сервера
  `media` нет вообще. Оператору всё равно следует убрать статическую запись из
  настроек — до этого момента поток 401 останавливает фильтр.
- Без токена ни блока, ни переменных нет — бот не ходит в сайдкар, и поток 401
  прекращается. Вместо ошибок компилятор записывает на проход сигнал «медиа не
  подключено»; лента внимания превращает его в карточку нового вида
  `bot_media_mcp` (severity `low`, advisory-ранг 13 — на ступень ниже
  `model_fallback_alert` (medium)), которая снимается сама, как только на проходе
  появился токен. Клиент на стороне бота
  (`tools/media-mcp/bot-scripts/media_client.py`) при пустом
  `MEDIA_TOOLS_TOKEN` (и не в режиме peer-аутентификации) поднимает
  `MediaNotConnectedError` до любого HTTP-запроса, а неожиданный 401 сводит к
  тому же состоянию «медиа не подключено» — это состояние конфигурации, а не
  ошибка времени выполнения.
- Боты с peer-аутентификацией продолжают работать, но MCP-блок `media` у них
  тоже исчезает: блок выдаётся только при bearer-токене в карточке
  (`MEDIA_TOOLS_TOKEN`). Бот, который ходит в фасад по `peer_host` (auth.py,
  `config.example.json`), ставит в env карточки `MEDIA_TOOLS_PEER_AUTH=1` — он
  зовёт фасад напрямую (скрипты бота и так знают endpoint), без bearer-токена;
  клиент не посылает Authorization и не бросает исключение.
  `MEDIA_TOOLS_PEER_AUTH` читает только клиент бота; компилятор эту переменную
  не читает, и блока `media` в любом случае не выдаёт.
- У реестра медиа-сервиса (`bots.json`) ровно один владелец: бордовый
  экспортёр MEDIA-PROVISION (`media-acl-export.ts`), который переписывает его
  из карточек и хранит sha256-дайджесты. Компилятор и бот-скрипты потребляют
  контракт реестра; второго генератора нет.

## settings-en

| `MYRMIDON_MEDIA_MCP_URL` | 1.6.5-F11-A | `http://media-mcp:8080/mcp` | URL of the media MCP sidecar the bots' profiles point at | Set it on the board instance when the sidecar runs under a different name or port |

## settings-ru

| `MYRMIDON_MEDIA_MCP_URL` | 1.6.5-F11-A | `http://media-mcp:8080/mcp` | URL медиа-сайдкара MCP, на который ссылаются профили ботов | Задаётся на инстансе доски, если сайдкар запущен под другим именем или портом |
