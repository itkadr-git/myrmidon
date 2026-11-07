---
settings-section: Track 5 — operations
---

## changelog-en

### IDLE-STOP board controls (OPE-7898)

- Enable idle container stopping by default, with live instance settings for the idle threshold and health timeout.
- Add per-agent On demand and Always on modes (agent card, plus a bot list with mass change under Instance settings), container state, and last stop/start times that survive a server restart.

## changelog-ru

### Управление IDLE-STOP на доске (OPE-7898)

- Остановка простаивающих контейнеров включена по умолчанию; порог простоя и таймаут health настраиваются без перезапуска.
- Добавлены режимы «по требованию» и «всегда активен» (в карточке агента и списком ботов с массовой сменой в настройках инстанса), состояние контейнера и время последней остановки/подъёма, не теряющееся при рестарте сервера.

## settings-en-append

<!-- section: Track 5 — operations -->

### OPE-7898 — IDLE-STOP board controls

IDLE-STOP is enabled by default. Instance settings control whether idle stopping is enabled, the idle threshold, and the health wait timeout; changes apply without restarting the server. Each bot can use On demand (default) or Always on mode. Always on containers are excluded from idle stopping. The mode is set on the agent card, or for many bots at once in the bot list under Instance settings (select bots, or change all); a change applies on the next sweep, with no restart. Both places show the container state (running, or stopped on idle) and the last stop/start times, read from the container itself.

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->

### OPE-7898 — управление IDLE-STOP на доске

IDLE-STOP включён по умолчанию. Настройки инстанса управляют включением остановки, порогом простоя и таймаутом ожидания health; изменения применяются без перезапуска сервера. Для каждого бота доступен режим «по требованию» (по умолчанию) или «всегда активен». Контейнеры в режиме «всегда активен» не останавливаются. Режим задаётся в карточке агента или сразу для многих ботов в списке ботов в настройках инстанса (выбрать ботов или изменить всех); смена действует со следующего прохода, без перезапуска. В обоих местах видно состояние контейнера (работает или остановлен по простою) и время последней остановки/подъёма, взятое у самого контейнера.
