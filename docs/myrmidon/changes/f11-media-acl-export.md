---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### The board generates the media ACL registry and the facade reloads it without a restart (MEDIA-PROVISION, part B)

- New exporter in the bot-container sweep (`server/src/myrmidon/bot-containers/media-acl-export.ts`):
  every reconcile pass collects the fleet's cards and rewrites the media MCP
  `bots.json` itself — for every container bot whose card env resolves a
  non-empty `MEDIA_TOOLS_TOKEN`, one entry `{token_sha256, peer_host, tools}`
  keyed by bot key, `peer_host` the container's docker-DNS name, `tools` the
  default allowlist of `tools/media-mcp/config.example.json`. A card without a
  token contributes no entry. The exporter never creates tokens (provisioning
  is the separate card-side half of the track) and never writes or logs the raw
  token — the file carries only its sha256.
- The rewrite is atomic (temp file + rename, mode 0600) and deterministic
  (bot keys sorted): the file is touched only when its text or mode actually
  changed, so the facade sees exactly the card changes. A failed export leaves
  the previous registry in place and is recorded in the reconcile activity log;
  a single card whose env cannot be resolved is skipped (counted), not fatal
  for the fleet.
- Because the exporter owns the file, hand-narrowed per-bot entries are
  rewritten back to the default allowlist on the next pass. Per-bot tool
  narrowing needs a card knob of its own (out of this part's scope).
- The media MCP facade hot-reloads the registry (`tools/media-mcp`): the
  authenticator now revalidates `bots.json` by an `(mtime_ns, size)` stamp
  before each authentication (stat at most once per `MEDIA_BOTS_RELOAD_INTERVAL_S`,
  default 1s) and re-reads it only when the stamp changed. A broken or vanished
  rewrite keeps the last valid registry and logs a warning — the facade stays
  up for the bots that already authenticate against it. Card changes reach the
  facade without a process restart.
- New settings: `MYRMIDON_MEDIA_BOTS_FILE` on the board server (where the
  exporter writes; default `/config/bots.json`, the facade's own
  `MEDIA_BOTS_FILE` default, so one shared bind of the same path needs no
  second setting) and `MEDIA_BOTS_RELOAD_INTERVAL_S` on the facade service.
  The exporter runs only while `MYRMIDON_BOT_CONTAINERS` is enabled.
- One-time rollout is NOT part of this change: regenerating the registry for
  the whole fleet and issuing tokens to the bots still without one stays an
  operator/release step after merge (it happens on the first enabled pass by
  itself — the exporter writes whatever the cards carry).

## changelog-ru

### Доска сама генерирует реестр media ACL, фасад перечитывает его без перезапуска (MEDIA-PROVISION, часть B)

- Новый экспортёр в проходе сверки контейнеров ботов
  (`server/src/myrmidon/bot-containers/media-acl-export.ts`): каждый проход
  собирает карточки флота и сам перезаписывает `bots.json` медиального MCP —
  для каждого контейнерного бота, у которого из env карточки разворачивается
  непустой `MEDIA_TOOLS_TOKEN`, одна запись `{token_sha256, peer_host, tools}`
  под ключом бота; `peer_host` — docker-DNS имя контейнера, `tools` — список
  инструментов по умолчанию из `tools/media-mcp/config.example.json`. У карты
  без токена записи нет. Экспортёр токены не создаёт (провижнинг — отдельная,
  карточная половина трека) и нигде не пишет и не логирует сырой токен — в
  файл идёт только его sha256.
- Перезапись атомарная (временный файл + переименование, режим 0600) и
  детерминированная (ключи ботов сортируются): файл трогается только когда его
  текст или режим реально изменились, поэтому фасад видит ровно изменения
  карточек. Сбойные записи сохраняют прежний реестр и пишутся в журнал
  активности сверки; одна карта с неразворачиваемым env пропускается (с
  подсчётом) и не убивает весь флот.
- Поскольку файл принадлежит экспортёру, вручную суженные для отдельного бота
  записи на следующем проходе возвращаются к списку по умолчанию. Сужение
  инструментов на бота требует отдельного поля карточки (вне рамок этой части).
- Фасад медиального MCP перечитывает реестр на горячую (`tools/media-mcp`):
  аутентификатор перед каждой проверкой перепроверяет `bots.json` по штампу
  `(mtime_ns, размер)` — stat не чаще одного раза за `MEDIA_BOTS_RELOAD_INTERVAL_S`
  (по умолчанию 1 с) — и перечитывает файл только когда штамп изменился. При
  битой или исчезнувшей перезаписи сохраняется последний валидный реестр, в
  журнал идёт предупреждение — фасад не падает для ботов, которые уже
  аутентифицируются по нему. Изменения карточек доходят до фасада без
  перезапуска процесса.
- Новые настройки: `MYRMIDON_MEDIA_BOTS_FILE` на сервере доски (куда пишет
  экспортёр; по умолчанию `/config/bots.json` — тот же путь, что у собственного
  `MEDIA_BOTS_FILE` фасада, поэтому одна общая привязка этого пути не требует
  второй настройки) и `MEDIA_BOTS_RELOAD_INTERVAL_S` на сервисе фасада.
  Экспортёр работает, только пока включён `MYRMIDON_BOT_CONTAINERS`.
- Одноразовая раскатка НЕ входит в изменение: пересоздать реестр для всего
  флота и выдать токены ботам, которые ещё без них, — шаг оператора/релиза
  после слияния (сам он и произойдёт на первом включённом проходе: экспортёр
  пишет то, что несут карточки).

## settings-en-append

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->
| `MYRMIDON_MEDIA_BOTS_FILE` | MEDIA-PROVISION B | `/config/bots.json` | Path where the board's media ACL exporter (media-acl-export.ts, one pass per reconciliation sweep while `MYRMIDON_BOT_CONTAINERS` is on) rewrites the media MCP bot registry from the fleet's cards: one entry per bot with a non-empty `MEDIA_TOOLS_TOKEN` in its card env — `{token_sha256, peer_host, tools}` — atomic temp+rename write, mode 0600, sorted keys, rewritten only when the text or mode changed. The default equals the facade's own `MEDIA_BOTS_FILE` default, so binding the same path into the media-mcp container needs no second setting. Raw tokens never enter the file or the log | Unset keeps `/config/bots.json`. To stop board-side generation entirely, disable `MYRMIDON_BOT_CONTAINERS` (the exporter rides the same flag) — while the flag is on the exporter owns the file: hand edits are reverted on the next sweep pass |
| `MEDIA_BOTS_RELOAD_INTERVAL_S` | MEDIA-PROVISION B | `1` | Facade service (media-mcp): shortest interval between two `bots.json` stamp checks (mtime_ns+size) done before each authentication; the file is re-read only when the stamp changed, so a board rewrite reaches the running facade without a restart. A failed reload (broken/vanished file) keeps the last valid registry and logs a warning | Empty or non-integer — `1`. Larger values trade propagation delay for fewer stats. Never drops below zero checks: with the watcher absent (library use of `Authenticator`) the registry behaves as before, read once at startup |

## settings-ru-append

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->
| `MYRMIDON_MEDIA_BOTS_FILE` | MEDIA-PROVISION B | `/config/bots.json` | Путь, куда экспортёр реестра media ACL доски (media-acl-export.ts, один проход за свип сверки при включённом `MYRMIDON_BOT_CONTAINERS`) перезаписывает реестр ботов медиального MCP по карточкам флота: по записи на бота с непустым `MEDIA_TOOLS_TOKEN` в env карточки — `{token_sha256, peer_host, tools}`; атомарная запись через временный файл и переименование, режим 0600, сортировка ключей, перезапись только при смене текста или режима. По умолчанию совпадает с собственным `MEDIA_BOTS_FILE` фасада, поэтому привязка того же пути в контейнер media-mcp не требует второй настройки. Сырые токены не попадают ни в файл, ни в журнал | Не задано — `/config/bots.json`. Остановить генерацию доской — выключить `MYRMIDON_BOT_CONTAINERS` (экспортёр живёт под тем же флагом); при включённом флаге файл принадлежит экспортёру: ручные правки возвращаются на следующем проходе свипа |
| `MEDIA_BOTS_RELOAD_INTERVAL_S` | MEDIA-PROVISION B | `1` | Сервис фасада (media-mcp): минимальный интервал между двумя проверками штампа `bots.json` (mtime_ns+размер) перед каждой аутентификацией; файл перечитывается только при смене штампа, поэтому перезапись доской доходит до работающего фасада без перезапуска. При сбое перечитки (битый или исчезнувший файл) остаётся последний валидный реестр, в журнал идёт предупреждение | Пусто или не целое — `1`. Больше значение — медленнее распространение, меньше stat-ов. Без наблюдателя (библиотечное использование `Authenticator`) реестр ведёт себя как раньше: читается один раз на старте |
