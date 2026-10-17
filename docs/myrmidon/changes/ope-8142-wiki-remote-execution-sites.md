## changelog-en

### Remote execution sites: a wiki page for the site-agent contract and the operator guide (OPE-8142)

- New wiki page pair `docs/wiki/Remote-execution-sites.md` +
  `Remote-execution-sites.ru.md` (linked from `docs/wiki/Home.md` and
  `Home.ru.md`): the one-way management plane (board → site over
  IPsec/WireGuard), the 13-route site-agent API of `fleetd`, the five site
  health states with epoch lease fencing, the secret-safe error reason
  codes, and the rollout runbook — canary migration, rollback without
  deleting data volumes.
- The page condenses the authoritative operator guide
  `docs/myrmidon/guides/remote-execution-sites.md` (EN/RU) and
  `docs/myrmidon/fleetd-vmexec.md` (EN/RU) delivered with the remote
  execution sites feature.

## changelog-ru

### Удалённые площадки исполнения: страница вики по контракту агента площадки и руководству оператора (OPE-8142)

- Новая пара страниц вики `docs/wiki/Remote-execution-sites.ru.md` +
  `Remote-execution-sites.md` (связана с `docs/wiki/Home.ru.md` и
  `Home.md`): односторонняя плоскость управления (доска → площадка через
  IPsec/WireGuard), API агента площадки `fleetd` из 13 маршрутов, пять
  состояний здоровья площадки с ограждением аренд по эпохе,
  секретобезопасные коды причин ошибок и порядок внедрения — канареечная
  миграция, откат без удаления томов с данными.
- Страница сжимает авторитетное руководство оператора
  `docs/myrmidon/guides/remote-execution-sites.ru.md` (RU/EN) и
  `docs/myrmidon/fleetd-vmexec.ru.md` (RU/EN), поставленное с функцией
  удалённых площадок исполнения.
