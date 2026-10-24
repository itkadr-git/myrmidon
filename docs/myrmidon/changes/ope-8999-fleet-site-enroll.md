<!-- bot/OPE-8999 — 1.6.6 fleet site enroll API, site PKI, operator guide section 4 -->

## changelog-en

### Execution sites are registered through the board API (1.6.6)

- New board-operator routes `GET/POST /api/companies/:companyId/fleet/sites` and
  `DELETE /api/companies/:companyId/fleet/sites/:name` enroll a site into
  `myrmidon_fleet_sites` without database edits. The request carries an `https://`
  fleetd address, the site CA (PEM, its fingerprint is stored), the names of company
  secrets for the bearer token and the client certificate and key, capacity and the
  gateway port range. Secret values never pass through the route; named secrets must
  exist, a name collision answers `409`.
- Operator guide section 4 (EN and RU) now matches the code: site PKI issuing steps,
  the real `fleetd.json` keys (`images`, `siteCA`, `serverCert`, `serverKey`,
  `gatewayPortStart`, `gatewayPortEnd`, `volumeRoot`) and mTLS health checks.

## changelog-ru

### Площадки исполнения регистрируются через API доски (1.6.6)

- Новые маршруты для операторов доски `GET/POST /api/companies/:companyId/fleet/sites` и
  `DELETE /api/companies/:companyId/fleet/sites/:name` записывают площадку в
  `myrmidon_fleet_sites` без правок базы. Запрос несёт адрес fleetd (`https://`), CA
  площадки (PEM, сохраняется отпечаток), имена секретов компании для Bearer-токена и
  клиентского сертификата с ключом, ёмкость и диапазон портов шлюза. Значения секретов
  через маршрут не проходят; названные секреты должны существовать, занятое имя даёт `409`.
- Раздел 4 инструкции оператора (EN и RU) приведён в соответствие с кодом: шаги выпуска
  PKI площадки, реальные ключи `fleetd.json` (`images`, `siteCA`, `serverCert`,
  `serverKey`, `gatewayPortStart`, `gatewayPortEnd`, `volumeRoot`) и проверки здоровья по mTLS.
