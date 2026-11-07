---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Fleetd remote site driver hardening

- Align remote-site contract fixtures with HTTPS-only fleet gateway URLs and
  require a token-secret reference in named fleet host fixtures.
- Keep fleet gateway placement HTTPS-only and document the fleetd environment
  settings through the release fragment.

## changelog-ru

- Контрактные fixtures удалённых площадок используют только HTTPS для fleetd,
  а именованные fleet-хосты требуют ссылку на секрет токена.
- Размещение через fleet gateway сохраняет HTTPS-only проверку; настройки
  fleetd вынесены в release fragment.

## settings-en-append

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->

| `MYRMIDON_FLEET_HOST_URL` / `MYRMIDON_FLEET_HOST_TOKEN` / `MYRMIDON_FLEET_HOST_CA` / `MYRMIDON_FLEET_HOST_CERT` / `MYRMIDON_FLEET_HOST_KEY` | FLEETD-VMEXEC | unset | HTTPS fleetd address, bearer token, and mTLS CA/client certificate/key; private key material is configured by the host deployment | Missing values disable the remote driver with a configuration error; local docker behavior is unchanged |
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | JSON array of named fleetd hosts, for example `[{"name":"...","url":"https://...","tokenSecret":"..."}]` | Empty/unset uses only the local driver; invalid JSON, unknown keys, duplicate names, non-HTTPS URLs, or empty `tokenSecret` is an error |

## settings-ru-append

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->

| `MYRMIDON_FLEET_HOST_URL` / `MYRMIDON_FLEET_HOST_TOKEN` / `MYRMIDON_FLEET_HOST_CA` / `MYRMIDON_FLEET_HOST_CERT` / `MYRMIDON_FLEET_HOST_KEY` | FLEETD-VMEXEC | unset | HTTPS-адрес fleetd, bearer-токен и mTLS CA/клиентский сертификат/ключ; закрытый ключ задаётся развёртыванием хоста | При отсутствии значений удалённый драйвер отключается с ошибкой конфигурации; локальный docker не изменяется |
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | JSON-массив именованных fleetd-хостов, например `[{"name":"...","url":"https://...","tokenSecret":"..."}]` | Пустое значение использует только локальный драйвер; ошибкой являются неверный JSON, неизвестные ключи, дубликаты имён, не-HTTPS URL или пустой `tokenSecret` |
