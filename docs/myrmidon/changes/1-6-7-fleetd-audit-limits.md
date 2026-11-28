## changelog-en

### fleetd: audit log, request limits, client certificate allowlist and clean-up

- fleetd writes one JSON audit line per API request to stdout (the journal): time, route, method,
  bot key, status, the SHA-256 of the client certificate and the duration. Bodies, query strings
  and tokens are not logged.
- A JSON request body is limited to 1 MiB. A restore is limited to 20 GiB of file content and
  2,000,000 archive entries; above that it answers `413 restore_too_large` and changes nothing.
  The HTTP server now has header, read and idle timeouts. It has no write timeout, so a long
  snapshot is not cut.
- New optional key `clientCertSha256` in `fleetd.json`: a list of SHA-256 fingerprints of the
  client certificates that may call the API. When the list is set, fleetd refuses any other
  certificate in the TLS handshake. When it is empty or absent, nothing changes. The board renews
  its client certificate, so do not pin a fingerprint without a plan for the renewal.
- fleetd removes the `.replaced-*` and `.quarantined-*` directories that are older than 7 days
  from the volume root, at start and then every 24 hours.
- The out-of-memory listener now also reports the containers that fleetd creates itself
  (`fleet-<botKey>`), not only `myrmidon-bot-*`.
- A systemd drop-in with sandboxing options for the fleetd unit is added in
  `docs/myrmidon/fleetd/myrmidon-fleetd.service.d/`.

## changelog-ru

### fleetd: журнал аудита, лимиты запросов, список клиентских сертификатов и очистка

- fleetd пишет одну JSON-строку аудита на каждый запрос к API в stdout (журнал): время, маршрут,
  метод, ключ бота, код ответа, SHA-256 клиентского сертификата и длительность. Тела запросов,
  строки запроса и токены не пишутся.
- Тело JSON-запроса ограничено 1 МиБ. Восстановление ограничено 20 ГиБ содержимого файлов и
  2 000 000 записей архива; сверх этого оно отвечает `413 restore_too_large` и ничего не меняет.
  У HTTP-сервера теперь есть таймауты заголовков, чтения и простоя. Таймаута записи нет, поэтому
  долгий снимок не обрывается.
- Новый необязательный ключ `clientCertSha256` в `fleetd.json`: список SHA-256-отпечатков
  клиентских сертификатов, которым разрешён API. Если список задан, fleetd отклоняет любой другой
  сертификат при TLS-рукопожатии. Если он пуст или не задан, ничего не меняется. Доска перевыпускает
  свой клиентский сертификат, поэтому не закрепляйте отпечаток без плана на перевыпуск.
- fleetd удаляет из корня томов каталоги `.replaced-*` и `.quarantined-*` старше 7 дней при старте
  и затем раз в 24 часа.
- Слушатель нехватки памяти теперь учитывает и контейнеры, которые fleetd создаёт сам
  (`fleet-<botKey>`), а не только `myrmidon-bot-*`.
- В `docs/myrmidon/fleetd/myrmidon-fleetd.service.d/` добавлен drop-in systemd с параметрами песочницы
  для юнита fleetd.
