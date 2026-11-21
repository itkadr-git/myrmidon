---
settings-section: Track 5 — operations
---

## changelog-en

### Remote sites: the board generates the site token, enroll is owner-only and limited to private addresses, bots of remote sites no longer break the local bot lists

- `POST /api/companies/:companyId/fleet/sites` no longer takes `tokenSecret`. The field named any secret of the company, and the board then sent the value of that secret as a bearer token, together with its client certificate, to the address from the same request. The board now generates a random token for each new site, keeps it in the company secret `myrmidon-fleet-site-token-<site>`, and returns it once in the enroll answer as `fleetd.token`. Put it in the `token` key of `fleetd.json`. A request that carries `tokenSecret` gets `400`. A site that is already enrolled keeps its own token secret and needs no action.
- The host of a site address (enroll, and a changed `url` in `PATCH`) must be a private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10) or a host listed in the new setting `MYRMIDON_FLEET_SITE_URL_ALLOWLIST`. Any other host gets `400` and the board issues no certificate and no key. A `PATCH` that leaves the stored address as it is is not checked again.
- Enroll, `PATCH` and delete of a site are for the company owner (and the instance admin). Before, a company admin could do it. Drain, resume, restart and stop stay open to the company admin.
- Moving a bot to another site, reading the status of a move and reading the log of a bot of a remote site (`/fleet/bots/:key/move`, `/fleet/bots/:key/logs`, `/api/myrmidon/fleet/bots/:key/logs`) need a company admin. Before, any member of the company could do it.
- The enroll answer carries `Cache-Control: no-store`: it holds the server key and the token.
- Deleting a site also deletes the token secret that the board generated for it. The token secret of an older site is never deleted with the site.
- The fleet router lists bots per host. `list` and `listRunning` sent every bot key to the local driver and to every site. The local dockergate refused each bot of a remote site (`bot_not_enrolled`), and one refused call failed the whole list, so the clone-report pass and the idle sweep saw no bot. Now each host gets only the bots of its own cards. A host that fails no longer fails the list: the failure is logged (`fleet routing: a host could not be listed`), and the list fails only when no host answered. The clone-report key list and the disk-quota sweep skip bots that run on a remote site.

## changelog-ru

### Удалённые площадки: токен площадки генерирует доска, регистрация только для владельца и только по частным адресам, боты удалённых площадок больше не ломают локальные списки ботов

- `POST /api/companies/:companyId/fleet/sites` больше не принимает `tokenSecret`. Поле называло любой секрет компании, а доска затем отправляла значение этого секрета как Bearer-токен вместе со своим клиентским сертификатом на адрес из того же запроса. Теперь доска сама генерирует случайный токен для каждой новой площадки, хранит его в секрете компании `myrmidon-fleet-site-token-<площадка>` и один раз возвращает в ответе enroll как `fleetd.token`. Его кладут в ключ `token` файла `fleetd.json`. Запрос с `tokenSecret` получает `400`. Уже зарегистрированная площадка сохраняет свой токен-секрет, действий не требуется.
- Хост адреса площадки (enroll и изменённый `url` в `PATCH`) должен быть частным адресом IPv4 (10/8, 172.16/12, 192.168/16, 100.64/10) или хостом из новой настройки `MYRMIDON_FLEET_SITE_URL_ALLOWLIST`. Любой другой хост получает `400`, и доска не выпускает ни сертификат, ни ключ. `PATCH`, который оставляет сохранённый адрес как есть, повторно не проверяется.
- Регистрация, `PATCH` и удаление площадки — для владельца компании (и администратора экземпляра). Раньше это мог сделать администратор компании. Drain, resume, restart и stop остаются доступны администратору компании.
- Перенос бота на другую площадку, чтение статуса переноса и чтение лога бота удалённой площадки (`/fleet/bots/:key/move`, `/fleet/bots/:key/logs`, `/api/myrmidon/fleet/bots/:key/logs`) требуют администратора компании. Раньше это мог сделать любой участник компании.
- Ответ enroll идёт с заголовком `Cache-Control: no-store`: в нём серверный ключ и токен.
- Удаление площадки удаляет и токен-секрет, который доска для неё сгенерировала. Токен-секрет старой площадки вместе с площадкой никогда не удаляется.
- Маршрутизатор флота перечисляет ботов по хостам. `list` и `listRunning` отправляли каждый ключ бота локальному драйверу и каждой площадке. Локальный dockergate отклонял каждого бота удалённой площадки (`bot_not_enrolled`), и один отклонённый вызов ронял весь список, поэтому проход отчётов о клонах и сторож простоя не видели ни одного бота. Теперь каждый хост получает только ботов своих карточек. Хост, который отказал, больше не роняет список: отказ пишется в журнал (`fleet routing: a host could not be listed`), а список падает только когда не ответил ни один хост. Список ключей для отчётов о клонах и проход дисковых квот пропускают ботов, которые работают на удалённой площадке.

## settings-en

| `MYRMIDON_FLEET_SITE_URL_ALLOWLIST` | 1.6.7 FLEET-SITE-ENROLL | unset (empty) | Hosts that may be the address of an execution site besides private IPv4 addresses (10/8, 172.16/12, 192.168/16, 100.64/10): host names or IP literals, separated by commas, semicolons or spaces, with no scheme and no port, compared in lower case. The board sends the token of a site and its client certificate to the address of the site, so a host name is trusted only when it is listed here. Read on every site enroll and address change, no restart | Unset or empty — only private IPv4 addresses are accepted. Removing an entry does not touch a site that is already enrolled with that host |

## settings-ru

| `MYRMIDON_FLEET_SITE_URL_ALLOWLIST` | 1.6.7 FLEET-SITE-ENROLL | не задан (пусто) | Хосты, которые могут быть адресом площадки помимо частных адресов IPv4 (10/8, 172.16/12, 192.168/16, 100.64/10): имена хостов или IP-адреса через запятую, точку с запятой или пробел, без схемы и порта, сравниваются в нижнем регистре. Доска отправляет токен площадки и свой клиентский сертификат на адрес площадки, поэтому имя хоста принимается только если оно перечислено здесь. Читается при каждой регистрации площадки и смене адреса, перезапуск не нужен | Не задано или пусто — принимаются только частные адреса IPv4. Удаление записи не затрагивает площадку, уже зарегистрированную с этим хостом |
