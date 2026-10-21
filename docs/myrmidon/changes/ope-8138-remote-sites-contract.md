## changelog-en

### Remote execution sites: site-agent contract and operator guide

Added the remote-site contract (health, lease claim, bot status, error discipline) with parsers and tests, an operator rollout guide, and `GET /v1/health` in fleetd (version, configurable `siteId` and `epoch`, live egress timestamp). Existing fleetd configs keep working: `siteId` defaults to `fleetd-local`, `epoch` to 1.

## changelog-ru

### Удалённые площадки: контракт site-agent и руководство оператора

Добавлен контракт удалённых площадок (health, захват аренды, статус бота, дисциплина ошибок) с парсерами и тестами, руководство оператора по раскатке и `GET /v1/health` в fleetd (версия, настраиваемые `siteId` и `epoch`, актуальная метка egress). Существующие конфиги fleetd работают: `siteId` по умолчанию `fleetd-local`, `epoch` — 1.
