---
settings-section: Bot containers (G-series, the 28.09 "option B" plan)
---

## changelog-en

### Fleetd remote site driver hardening

- Align remote-site contract fixtures with HTTPS-only fleet gateway URLs and
  require a token-secret reference in named fleet host fixtures.
- Keep fleet gateway placement HTTPS-only and document the new fleetd and
  knowledge-distill environment settings through the release fragment.

## changelog-ru

- Контрактные fixtures удалённых площадок используют только HTTPS для fleetd,
  а именованные fleet-хосты требуют ссылку на секрет токена.
- Размещение через fleet gateway сохраняет HTTPS-only проверку; новые настройки
  fleetd и knowledge-distill вынесены в release fragment.

## settings-en-append

<!-- section: Bot containers (G-series, the 28.09 "option B" plan) -->

| `MYRMIDON_DISTILL_AUTO_ACCEPT` / `MYRMIDON_DISTILL_GATEWAY_URL` / `MYRMIDON_DISTILL_INTERVAL_SEC` / `MYRMIDON_DISTILL_KEY_SECRET` / `MYRMIDON_DISTILL_MAX_DURATION_SEC` / `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` / `MYRMIDON_DISTILL_MAX_TASKS` / `MYRMIDON_DISTILL_MODEL` / `MYRMIDON_DISTILL_WINDOW_SEC` | 1.6.6 knowledge distill | built-in defaults | Numeric limits and gateway settings for the distill pass; raw keys never enter logs or settings responses | Invalid or missing values fall back to stored settings or built-ins; gateway/key settings are required when enabled |
| `MYRMIDON_DISTILL_AUTO_ACCEPT` | 1.6.6 knowledge distill | unset | Comma-separated distill section names accepted automatically | Empty/unset leaves sections pending review |
| `MYRMIDON_FLEET_HOST_URL` / `MYRMIDON_FLEET_HOST_TOKEN` | FLEETD-VMEXEC | unset | HTTPS fleetd address and bearer token; mTLS material is configured by the host deployment | Missing values disable the remote driver with a configuration error; local docker behavior is unchanged |
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | JSON array of named fleetd hosts, for example `[{"name":"...","url":"https://...","tokenSecret":"..."}]` | Empty/unset uses only the local driver; invalid JSON, unknown keys, duplicate names, non-HTTPS URLs, or empty `tokenSecret` is an error |

## settings-ru-append

<!-- section: Контейнеры ботов (G-серия, план 28.09 «вариант Б») -->

| `MYRMIDON_DISTILL_AUTO_ACCEPT` / `MYRMIDON_DISTILL_GATEWAY_URL` / `MYRMIDON_DISTILL_INTERVAL_SEC` / `MYRMIDON_DISTILL_KEY_SECRET` / `MYRMIDON_DISTILL_MAX_DURATION_SEC` / `MYRMIDON_DISTILL_MAX_INPUT_TOKENS` / `MYRMIDON_DISTILL_MAX_TASKS` / `MYRMIDON_DISTILL_MODEL` / `MYRMIDON_DISTILL_WINDOW_SEC` | 1.6.6 knowledge distill | встроенные значения | Числовые лимиты и настройки gateway для дистилляции; ключи не попадают в журналы и ответы настроек | Некорректные или отсутствующие значения используют сохранённые или встроенные значения; gateway/key обязательны при включении |
| `MYRMIDON_DISTILL_AUTO_ACCEPT` | 1.6.6 knowledge distill | unset | Список разделов дистилляции, принимаемых автоматически | Пустое значение оставляет предложения на проверку |
| `MYRMIDON_FLEET_HOST_URL` / `MYRMIDON_FLEET_HOST_TOKEN` | FLEETD-VMEXEC | unset | HTTPS-адрес fleetd и bearer-токен; mTLS-материалы задаются развёртыванием хоста | При отсутствии значений удалённый драйвер отключается с ошибкой конфигурации; локальный docker не изменяется |
| `MYRMIDON_FLEET_HOSTS` | FLEETD-VMEXEC | unset (empty) | JSON-массив именованных fleetd-хостов, например `[{"name":"...","url":"https://...","tokenSecret":"..."}]` | Пустое значение использует только локальный драйвер; ошибкой являются неверный JSON, неизвестные ключи, дубликаты имён, не-HTTPS URL или пустой `tokenSecret` |
