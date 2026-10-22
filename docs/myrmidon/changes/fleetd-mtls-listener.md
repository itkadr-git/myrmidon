<!-- bot/OPE-7649 — 1.6.6 fleetd: mTLS listener (site-agent v1, part 1) -->

## changelog-en

### fleetd: mutual-TLS listener for the site API (1.6.6)

- `tools/fleetd` serves the `/v1` API over TLS and requires a client
  certificate signed by the site CA (`tls.RequireAndVerifyClientCert`, TLS 1.2+).
  New optional JSON config keys: `siteCA`, `serverCert`, `serverKey` (absolute
  paths). A partial set or a relative path fails `--check-config`; starting the
  server without all three is refused. `--check-config` without the TLS block
  stays valid, so existing smoke-test configs keep working.
- The bearer token check stays on top of mTLS. TLS setup errors never include
  key material. This is the listener part of site-agent v1; the Docker backend
  operations are delivered separately.

## changelog-ru

### fleetd: слушатель с взаимной TLS-аутентификацией для API площадки (1.6.6)

- `tools/fleetd` отдаёт API `/v1` по TLS и требует клиентский сертификат,
  подписанный site-CA (`tls.RequireAndVerifyClientCert`, TLS 1.2+). Новые
  необязательные ключи JSON-конфига: `siteCA`, `serverCert`, `serverKey`
  (абсолютные пути). Неполный набор или относительный путь роняют
  `--check-config`; запуск сервера без всех трёх отклоняется. `--check-config`
  без TLS-блока остаётся валидным — существующие smoke-конфиги работают.
- Bearer-токен проверяется поверх mTLS. Ошибки настройки TLS не содержат
  ключевого материала. Это часть site-agent v1 про слушатель; операции
  Docker-бэкенда сдаются отдельно.
