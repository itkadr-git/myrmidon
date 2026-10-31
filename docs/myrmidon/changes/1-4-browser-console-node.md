---
divergence-section: 1.4 — экран живого браузера (BROWSER-CONSOLE)
settings-section: 1.4 — live browser screen (BROWSER-CONSOLE)
---

## changelog-en

### Live browser screen is connected (BROWSER-CONSOLE part B)

- Settings -> Browsers: pressing "Open screen" now shows the live Chromium
  picture. The panel signs a short-lived (5-minute) Guacamole auth-JSON for a
  VNC connection and loads the shared Guacamole client in the screen frame —
  the same client, URL and `guacamole-json-secret-key` as the server console;
  no second Guacamole deployment. The picture rides guacd -> x11vnc on the
  exec host (Xvfb :99); the board talks to the exec host through the new
  screen node, and activity on the panel keeps the session timers alive.
- New settings: `MYRMIDON_BROWSER_VNC_TARGET` (the `host[:port]` guacd must
  reach; unset — the console token answers 503, the session itself keeps
  working) and `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` (endpoint -> browser map
  for the gateway pause guard).
- The bot pause got its server-side insurance wired into the tool gateway:
  while an owner screen session is open, MCP calls aimed at the live browser
  answer 423 before reaching the browser.
- New operational service on the exec host: `browser-console-node.service`
  (ops/browser-console-node, python3 stdlib) — opens/stops the x11vnc session
  units, stops/starts the bot MCP path on pause/resume, clears site data over
  CDP, and releases the screen itself if the board stopped reporting
  heartbeats (2 minutes). Install/rollback scripts ship with the node.

## changelog-ru

### Экран живого браузера подключён (BROWSER-CONSOLE, часть B)

- Settings -> Browsers: нажатие «Открыть экран» теперь показывает живую
  картинку Chromium. Панель подписывает короткоживущий (5 минут)
  Guacamole auth-JSON для VNC-соединения и загружает общий guacamole-client в
  рамку экрана — тот же клиент, тот же URL и тот же секрет
  `guacamole-json-secret-key`, что у консоли серверов; второй деплой
  Guacamole не поднимается. Картинка идёт через guacd -> x11vnc на
  исполняющем хосте (Xvfb :99); доска говорит с хостом через новую экранный
  узел, а активность на панели держит таймеры сессии.
- Новые настройки: `MYRMIDON_BROWSER_VNC_TARGET` (`host[:port]`, до которого
  дотягивается guacd; не задан — выдача токена отвечает 503, сама сессия
  продолжает работать) и `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` (отображение
  эндпоинт -> браузер для пауза-страховки в шлюзе инструментов).
- Серверная страховка паузы ботов врезана в шлюз инструментов: пока
  экранная сессия владельца открыта, MCP-вызовы к живому браузеру получают
  423, не доходя до браузера.
- Новый эксплуатационный сервис на исполняющем хосте:
  `browser-console-node.service` (ops/browser-console-node, python3 stdlib) —
  поднимает/гасит юниты x11vnc на время сессии, останавливает и запускает
  путь ботов (pause/resume), чистит данные сайта через CDP и сам гасит
  экран, если доска перестала присылать heartbeat (2 минуты). Скрипты
  установки и отката идут вместе с узлом.

## divergence

| ID | Что меняем | Файлы вендора | Причина | Тест-сторож | Как снимать | PR |
| BROWSER-CONSOLE-B | Часть B — экран подключён: (1) выдача Guacamole auth-JSON — `server/src/myrmidon/browser-console/settings.ts` и `console-token.ts`, маршрут POST `/api/myrmidon/browsers/:id/screen/console-token` (owner, существующая сессия части A, TTL 5 мин, тот же секрет `guacamole-json-secret-key`, что у SERVER-CONSOLE; без `MYRMIDON_BROWSER_VNC_TARGET` — `503 console_not_configured`); вместо WS-прокси экрана, намеченного в части A, картинка едет через guacd/VNC к x11vnc — решение step0-solution-choice, прокси не строим; (2) UI: `BrowserScreenPanel.tsx` — iframe на `consoleUrl` по прецеденту `FleetConsolePanel.tsx`, активность панели (pointer/key/focus/visibilitychange, debounce 5 с) шлёт heartbeat `activity=true`; (3) серверная страховка паузы врезана в шлюз инструментов: вызов `browserConsoleMcpPauseForEndpoint` до диспатча удалённого MCP-вызова в `server/src/services/tool-gateway.ts` (своя помеченная точка) — 423 `browser_console_mcp_paused` по `MYRMIDON_BROWSER_CONSOLE_MCP_URLS`; (4) нода экрана — новый эксплуатационный сервис вне дерева вендора: `ops/browser-console-node/` (python3 stdlib: HTTP-контракт `ScreenConsoleClient`, systemd-run transient-юнит `browser-screen-x11vnc@<browser>` c x11vnc без `-localhost` (guacd на другой машине; `-nopw` — авторизация коротким signed auth-JSON), страховка heartbeat: нет heartbeat 2 мин → юнит гасится сам; pause/resume = systemctl stop/start `mcp-reaper-proxy.service`; clear-site-data через CDP 127.0.0.1 руками по RFC6455), юнит `browser-console-node.service`, env-шаблон, `deploy/install.sh`/`rollback.sh` с бэкапом предыдущей установки | `server/src/services/tool-gateway.ts` (одна помеченная точка вызова), `ui/src/components/myrmidon/browsers/**`, `packages/shared/src/myrmidon-browser-console.ts` (контракт VNC-цели); `ops/browser-console-node/**` — наше, не вендор | Владельцу нужен живой экран Chromium без участия оператора; guacd/VNC переиспользует клиент и секрет SERVER-CONSOLE, отдельный WS-прокси доски не нужен | `server/src/myrmidon/browser-console/console-token.myrmidon.test.ts` и `service.myrmidon.test.ts` (красный без правки: нарушить привязку `expires = now + TTL` в `console-token.ts` — round-trip-ассерт падает), `mcp-guard.myrmidon.test.ts` (423 на открытом экране / проходит без сессии), `ui/src/components/myrmidon/browsers/BrowsersSettingsPage.myrmidon.test.tsx` (iframe), `ops/browser-console-node/tests/test_node.py` (stdlib unittest: контракт методов, страховка heartbeat, маскирование RFC6455) | Никогда, наше поведение. Выкладку ноды на исполняющий хост делает релиз: `ops/browser-console-node/deploy/install.sh`; токен ноды генерирует release, в репозиторий не попадает | (этот PR) |

## settings-en

| `MYRMIDON_BROWSER_VNC_TARGET` | BROWSER-CONSOLE-B | unset (off) | Part B: the `host[:port]` x11vnc endpoint guacd must reach for the live screen (default port 5900). The panel signs the Guacamole auth-JSON for POST `/screen/console-token` with this target as the VNC connection; the picture rides the same Guacamole client as the server console (`MYRMIDON_FLEET_CONSOLE_URL`, secret `guacamole-json-secret-key`) | Unset, empty or malformed — the console token answers `503 console_not_configured`; the screen session and its lifecycle keep working without the picture. Read at route assembly on server startup |
| `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` | BROWSER-CONSOLE-B | unset (guard off) | Part B: a JSON object mapping the live browser MCP endpoint (what the tool gateway resolves for a connection, e.g. the reaper-proxy URL) to the fleet browser id. The gateway pause guard consults it before dispatching an MCP call: an open owner screen session on that browser answers `423 browser_console_mcp_paused` | Unset or invalid JSON — the mapping reads as empty and no endpoint is treated as a live browser, so MCP calls pass (fail-open, warned in the server log) |

## settings-ru

| `MYRMIDON_BROWSER_VNC_TARGET` | BROWSER-CONSOLE-B | не задано (выключено) | Часть B: эндпоинт x11vnc в формате `host[:port]`, до которого должен дотягиваться guacd для живого экрана (порт по умолчанию 5900). Панель подписывает Guacamole auth-JSON для POST `/screen/console-token` с этой VNC-целью; картинка едет через тот же guacamole-client, что и консоль серверов (`MYRMIDON_FLEET_CONSOLE_URL`, секрет `guacamole-json-secret-key`) | Не задано, пусто или неверный формат — выдача токена отвечает `503 console_not_configured`; экранная сессия и её жизненный цикл продолжают работать без картинки. Читается при сборке маршрутов на старте сервера |
| `MYRMIDON_BROWSER_CONSOLE_MCP_URLS` | BROWSER-CONSOLE-B | не задано (страховка выключена) | Часть B: JSON-объект, отображающий MCP-эндпоинт живого браузера (то, что шлюз инструментов разрешает для подключения, например URL прокси репера) в id браузера реестра. Pause-страховка шлюза сверяется с ним перед отправкой MCP-вызова: при открытой экранной сессии владельца на этом браузере вызов получает `423 browser_console_mcp_paused` | Не задано или невалидный JSON — отображение читается пустым, ни один эндпоинт не считается живым браузером, MCP-вызовы проходят (fail-open, предупреждение в лог сервера) |
