<!-- bot/OPE-8136 — 1.6.6 fleetd: centralized-memory client boundary -->

## changelog-en

### fleetd: optional centralized-memory client boundary (1.6.6)

- `tools/fleetd` gains an isolated HTTP client for the centralized memory
  service, configured by an optional `memory` block in the fleetd JSON
  configuration (`enabled`, `url`, `token`, `bank`, `timeoutMs`). Disabled by
  default: without the block, the new `/v1/memory/recall` and `/v1/memory/retain`
  routes answer `503 centralized_memory_disabled` and no outbound traffic
  happens.
- The boundary speaks only HTTP(S) to the configured URL — no `/host` mount,
  no docker.sock, no host filesystem paths. A non-http(s) URL, an embedded
  credential, or a missing bank fails `--check-config` validation instead of
  starting.
- Upstream failures surface as explicit errors (`memory upstream returned HTTP
  <code>`, `memory upstream unavailable`), never as panics or silent
  degradation; responses are size-capped and every request carries a timeout.

## changelog-ru

### fleetd: изолированный клиент централизованной памяти (1.6.6)

- В `tools/fleetd` добавлен изолированный HTTP-клиент централизованной памяти:
  необязательный блок `memory` в JSON-конфигурации fleetd (`enabled`, `url`,
  `token`, `bank`, `timeoutMs`). По умолчанию выключен: без блока маршруты
  `/v1/memory/recall` и `/v1/memory/retain` отвечают
  `503 centralized_memory_disabled`, исходящего трафика нет.
- Граница говорит только по HTTP(S) с настроенным URL — без монтирования
  `/host`, без docker.sock и без путей файловой системы хоста. Не-http(s) URL,
  встроенные креды или пустой банк роняют валидацию `--check-config`, а не
  запуск.
- Ошибки апстрима возвращаются явными сообщениями (`memory upstream returned
  HTTP <code>`, `memory upstream unavailable`), без паник и тихих деградаций;
  ответы ограничены по размеру, каждый запрос имеет таймаут.

## settings-en

| `FLEETD_MEMORY_*` (JSON config `memory` block) | 1.6.6 fleetd | off (block absent) | Centralized-memory client for fleetd: `enabled`, `url` (http(s) only), `token`, `bank`, `timeoutMs`. When enabled, `/v1/memory/recall` and `/v1/memory/retain` proxy to the bank service | Omit the `memory` block or set `enabled: false` |

## settings-ru

| `FLEETD_MEMORY_*` (JSON config `memory` block) | 1.6.6 fleetd | выключен (блока нет) | Клиент централизованной памяти fleetd: `enabled`, `url` (только http(s)), `token`, `bank`, `timeoutMs`. При включении `/v1/memory/recall` и `/v1/memory/retain` проксируют в сервис банка | Убрать блок `memory` или поставить `enabled: false` |
