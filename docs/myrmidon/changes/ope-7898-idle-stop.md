---
settings-section: Track 5 — operations
---

## changelog-en

### IDLE-STOP board controls (OPE-7898)

- Enable idle container stopping by default, with live instance settings for the idle threshold and health timeout.
- Add per-agent On demand and Always on modes, runtime state, and last stop/start timestamps.

## changelog-ru

### Управление IDLE-STOP на доске (OPE-7898)

- Остановка простаивающих контейнеров включена по умолчанию; порог простоя и таймаут health настраиваются без перезапуска.
- Добавлены режимы «по требованию» и «всегда активен», состояние и время последней остановки/подъёма.

## settings-en-append

<!-- section: Track 5 — operations -->

### OPE-7898 — IDLE-STOP board controls

IDLE-STOP is enabled by default. Instance settings control whether idle stopping is enabled, the idle threshold, and the health wait timeout; changes apply without restarting the server. Each bot can use On demand (default) or Always on mode. Always on containers are excluded from idle stopping. The agent card shows the container state and the last stop/start timestamps.

## settings-ru-append

<!-- section: Трек 5 — эксплуатация -->

### OPE-7898 — управление IDLE-STOP на доске

IDLE-STOP включён по умолчанию. Настройки инстанса управляют включением остановки, порогом простоя и таймаутом ожидания health; изменения применяются без перезапуска сервера. Для каждого бота доступен режим «по требованию» (по умолчанию) или «всегда активен». Контейнеры в режиме «всегда активен» не останавливаются. В карточке агента отображаются состояние контейнера и время последней остановки/подъёма.
