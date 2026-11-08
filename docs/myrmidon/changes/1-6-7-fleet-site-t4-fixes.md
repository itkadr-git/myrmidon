## changelog-en

### Remote sites: fleet restart/stop/logs reach the site, the network profile is editable, a new bot's first apply no longer races

- Fleet bot actions (`POST /api/myrmidon/fleet/bots/:key/restart|stop`, `GET …/logs`) looked up the site transport
  as `companyId:siteName`, while the client manager keys it as `companyId/siteName` (`fleetSiteKey`): every call
  answered 502 "no valid mTLS client certificate". The lookups now use `fleetSiteKey`.
- The same `companyId:siteName` lookup broke the bot move between sites (`fleet-move-wiring`); fixed the same way.
- The fleet client manager kept the old site row when a refresh found the connection unchanged, so a changed
  profile, status or capacity never reached `getSite()` (the hermes adapter's plain-http check) until a restart.
  The fresh row now replaces the cached one; the client is kept.
- `PATCH /api/myrmidon/fleet/sites/:name` accepts `privateNetwork` and `tunnel` and merges them into the stored
  site profile (admin only). A site enrolled without `privateNetwork` could not get it later, and the hermes
  adapter refused its plain-http gateway on an IPsec-internal address.
- The bot profile compiler ensures the card's board API key before the parallel block: the MCP source listing
  ensures it too, and on a new bot's first apply the two concurrent get-or-create calls both created the
  secret ("Secret already exists: …-paperclip-api-key").

## changelog-ru

### Удалённые площадки: restart/stop/логи доходят до площадки, сетевой профиль правится, первый apply нового бота без гонки

- Действия над ботами флота (`POST /api/myrmidon/fleet/bots/:key/restart|stop`, `GET …/logs`) искали транспорт
  площадки по ключу `companyId:siteName`, а менеджер клиентов хранит его как `companyId/siteName` (`fleetSiteKey`):
  каждый вызов отвечал 502 «no valid mTLS client certificate». Теперь поиск через `fleetSiteKey`.
- Тот же поиск по `companyId:siteName` ломал перенос бота между площадками (`fleet-move-wiring`); исправлен так же.
- Менеджер клиентов площадок при обновлении с неизменным соединением оставлял старую строку площадки: изменённый
  профиль, статус или ёмкость не доходили до `getSite()` (проверки plain http в адаптере hermes) до перезапуска.
  Теперь свежая строка заменяет закешированную, клиент сохраняется.
- `PATCH /api/myrmidon/fleet/sites/:name` принимает `privateNetwork` и `tunnel` и вливает их в сохранённый профиль
  площадки (только администратор). Площадке, зарегистрированной без `privateNetwork`, его нельзя было задать позже,
  и адаптер hermes отказывал её шлюзу по plain http на адресе внутри IPsec.
- Сборщик профиля бота получает ключ API доски для карточки до параллельного блока: список MCP-источников получает
  его тоже, и при первом apply нового бота два одновременных «получить или создать» оба создавали секрет
  («Secret already exists: …-paperclip-api-key»).
