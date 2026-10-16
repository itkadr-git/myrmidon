---
settings-section: Track 5 — operations
---

## changelog-en

### Server onboarding registry and job lifecycle (SERVER-ONBOARD A)

- Add a company-scoped server registry and onboarding job API, gated off by default.
- Store bootstrap credentials and generated access keys through the board secret store; expose only the executor claim/report contract.

## changelog-ru

### Реестр серверов и жизненный цикл онбординга (SERVER-ONBOARD A)

- Добавлены реестр серверов компании и API задач онбординга; по умолчанию функция выключена.
- Начальные учётные данные и сгенерированные ключи хранятся через хранилище секретов доски; наружу доступен только контракт получения и отчёта исполнителя.

## settings-en

| `MYRMIDON_FLEET_ONBOARD_ENABLED` | SERVER-ONBOARD A | `false` | Enables fleet server onboarding writes; read-only registry access remains available while disabled | `false`, `0`, `no`, or `off` disables onboarding; default is disabled |
| `MYRMIDON_FLEET_ONBOARD_STEP_TIMEOUT_SEC` | SERVER-ONBOARD A | `1800` | Maximum duration of one onboarding step | Values outside 30–86400 seconds use the default |
| `MYRMIDON_FLEET_ONBOARD_TICK_SEC` | SERVER-ONBOARD A | `60` | Interval at which the onboarding service reconciles queued jobs | Values outside 5–3600 seconds use the default |
| `MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN` | SERVER-ONBOARD A | unset | Bearer token required by executor claim/report routes; configure it as a deployment secret | Unset or empty disables executor claim/report; never log or publish the value |
| `MYRMIDON_FLEET_ONBOARD_KEEP_PASSWORD` | SERVER-ONBOARD A | `true` | Allows an owner to retain the bootstrap password secret when requested | `false`, `0`, `no`, or `off` disallows retaining it |

## settings-ru

| `MYRMIDON_FLEET_ONBOARD_ENABLED` | SERVER-ONBOARD A | `false` | Включает операции добавления серверов в парк; чтение реестра остаётся доступно при выключенной функции | `false`, `0`, `no` или `off` выключает онбординг; по умолчанию выключен |
| `MYRMIDON_FLEET_ONBOARD_STEP_TIMEOUT_SEC` | SERVER-ONBOARD A | `1800` | Максимальная длительность одного шага онбординга | При значении вне диапазона 30–86400 секунд используется умолчание |
| `MYRMIDON_FLEET_ONBOARD_TICK_SEC` | SERVER-ONBOARD A | `60` | Интервал сверки очереди задач сервисом онбординга | При значении вне диапазона 5–3600 секунд используется умолчание |
| `MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN` | SERVER-ONBOARD A | не задан | Bearer-токен для маршрутов получения задачи и отчёта исполнителя; задавайте его как секрет выката | Если не задан или пуст — получение задач и отчёты исполнителя выключены; значение нельзя журналировать или публиковать |
| `MYRMIDON_FLEET_ONBOARD_KEEP_PASSWORD` | SERVER-ONBOARD A | `true` | Разрешает владельцу сохранить секрет начального пароля по запросу | `false`, `0`, `no` или `off` запрещает его сохранение |