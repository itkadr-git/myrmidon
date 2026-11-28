## changelog-en

### Remote sites: plain http is checked against the site record, fleet calls are audited, snapshots drop secret files

- The hermes adapter allowed plain http to a bot gateway on a remote site when only the host name matched the site.
  It now needs all of these: the site is active and marked `privateNetwork` or `tunnel`; the site address and the
  target are IP literals in a private range (RFC 1918, RFC 6598 shared address space or loopback); the target host is the site host;
  and the target port is inside the gateway port range of the site record (`gatewayPortStart`..`gatewayPortEnd`).
  A site record without a port range allows no plain-http port. The `dangerouslyAllowInsecureRemoteHttp` flag of a
  card is not changed.
- The site registry is the only source of the site. The `fleetSite` and `fleetSites` fields of a card were read
  before the registry and could describe a site that does not exist; they are not read any more.
- `PATCH /api/myrmidon/fleet/sites/:name` takes `privateNetwork: true` and `tunnel: true` for a private IP address of
  the site only (400 otherwise), and a site that carries a flag cannot be moved to another kind of address unless
  the flags are cleared in the same request. The request also takes `gatewayPortStart` and `gatewayPortEnd`, so a
  site that has no range (the env bootstrap writes none) can get one.
- `MYRMIDON_FLEET_HOSTS` is deprecated. An `http://` address in it (`url`, `hindsightUrl`, `llmBaseUrl`) must now be
  a private IP literal; a DNS name or a public address is refused. The board logs a warning at start while the
  variable is set. Register sites with `POST /api/companies/:companyId/fleet/sites` instead.
- Control calls on remote sites leave a row in the company activity log: `fleet.site.enroll`, `fleet.site.patch`,
  `fleet.site.drain`, `fleet.site.resume`, `fleet.site.delete`, `fleet.bot.restart`, `fleet.bot.stop`,
  `fleet.bot.move`, `fleet.bot.logs` (entity `fleet_site` or `agent`). A row says who, what, the outcome
  (`ok`, `denied`, `rejected`, `failed`) and a few non-secret facts. It never holds a token, a secret name, a
  certificate or a log. Only an actor of the company writes into its trail. Reading a log is recorded once a minute
  per actor and bot.
- The replica store no longer keeps the secret profile files. A stored snapshot leaves out `hermes/.env` and
  `hermes/config.yaml` (the files the profile compiler writes as secrets), and its manifest is rewritten to match.
  The apply that follows every restore writes the files again. A snapshot that cannot be read and checked in full is
  refused, and the previous replica stays. Replicas that were stored before this change are replaced on the next two
  snapshot passes.

## changelog-ru

### Удалённые площадки: plain http сверяется с записью площадки, вызовы флота пишутся в аудит, снимки без секретных файлов

- Адаптер hermes разрешал plain http к шлюзу бота на удалённой площадке, если совпадало только имя хоста.
  Теперь нужно всё сразу: площадка активна и помечена `privateNetwork` или `tunnel`; адрес площадки и цель —
  IP-адреса из частного диапазона (RFC 1918, общее адресное пространство RFC 6598 или loopback); хост цели — хост площадки; порт цели
  внутри диапазона портов шлюзов из записи площадки (`gatewayPortStart`..`gatewayPortEnd`). Запись площадки без
  диапазона портов не открывает ни одного порта для plain http. Флаг `dangerouslyAllowInsecureRemoteHttp` в
  карточке не менялся.
- Единственный источник площадки — реестр площадок. Поля `fleetSite` и `fleetSites` карточки читались раньше
  реестра и могли описать несуществующую площадку; теперь они не читаются.
- `PATCH /api/myrmidon/fleet/sites/:name` принимает `privateNetwork: true` и `tunnel: true` только для частного
  IP-адреса площадки (иначе 400); площадку с флагом нельзя перенести на адрес другого рода, если флаги не сняты в
  том же запросе. Запрос принимает и `gatewayPortStart`/`gatewayPortEnd`, чтобы площадка без диапазона (env-загрузка
  его не пишет) могла его получить.
- `MYRMIDON_FLEET_HOSTS` объявлена устаревшей. Адрес `http://` в ней (`url`, `hindsightUrl`, `llmBaseUrl`) теперь
  должен быть частным IP-адресом; DNS-имя и публичный адрес отклоняются. Пока переменная задана, доска пишет
  предупреждение при старте. Площадки регистрируются через `POST /api/companies/:companyId/fleet/sites`.
- Управляющие вызовы по удалённым площадкам оставляют строку в журнале активности компании: `fleet.site.enroll`,
  `fleet.site.patch`, `fleet.site.drain`, `fleet.site.resume`, `fleet.site.delete`, `fleet.bot.restart`,
  `fleet.bot.stop`, `fleet.bot.move`, `fleet.bot.logs` (объект `fleet_site` или `agent`). В строке: кто, что,
  исход (`ok`, `denied`, `rejected`, `failed`) и несколько несекретных фактов; токенов, имён секретов,
  сертификатов и логов в ней нет. В журнал компании пишет только её участник. Чтение лога пишется раз в минуту на
  пару «участник — бот».
- Хранилище реплик больше не держит секретные файлы профиля. В сохранённом снимке нет `hermes/.env` и
  `hermes/config.yaml` (файлов, которые сборщик профиля пишет как секретные), а манифест пересчитан. Apply после
  каждого восстановления записывает эти файлы заново. Снимок, который нельзя прочитать и проверить целиком,
  отклоняется, предыдущая реплика остаётся. Реплики, сохранённые до этого изменения, заменятся за два следующих
  прохода снимков.
