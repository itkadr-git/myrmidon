## settings-en-new

<!-- after: 1.6.5 — SWARM: the board pairs tasks with free agents, no "look for work" wakes -->

### 1.6.6 — FORAGING: vm-exec edge fetch

The foraging reader (`server/src/myrmidon/foraging/reader.ts`) reads sources strictly through the external fetch gateway instead of directly from the board host (gateway-only, fail-closed). Both URL and token variables are required; without them direct source fetch from vm-core is safely refused.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_FORAGING_FETCHER_URL` | FORAGING edge fetch | unset | Base URL of the edge fetch gateway (e.g. on myr-vm1) that reads foraging sources from outside the board host. | Unset or empty — falls back to `MYRMIDON_VMEXEC_URL`. If neither is set, safely refuses (fail-closed, 0 outbound calls from vm-core). |
| `MYRMIDON_FORAGING_FETCHER_TOKEN` | FORAGING edge fetch | unset | Bearer token for the edge fetch gateway, paired with `MYRMIDON_FORAGING_FETCHER_URL`. Never logged. | Unset or empty — falls back to `MYRMIDON_VMEXEC_TOKEN`. |
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | unset | Legacy base URL of the fetch gateway. Deprecated in favor of `MYRMIDON_FORAGING_FETCHER_URL`. | Unset or empty — falls back to fail-closed error unless `MYRMIDON_FORAGING_FETCHER_URL` is set. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | unset | Legacy Bearer token for the fetch gateway. Never logged. | Unset or empty — falls back to fail-closed error unless `MYRMIDON_FORAGING_FETCHER_TOKEN` is set. |

## settings-ru-new

<!-- after: 1.6.5 — SWARM: сопоставление на доске, без побудок «поищи работу» -->

### 1.6.6 — FORAGING: чтение источников через vm-exec

Читатель источников фуражировки (`server/src/myrmidon/foraging/reader.ts`) читает источники строго через внешний шлюз выборки, а не напрямую с хоста доски (режим gateway-only, fail-closed). Требуются обе переменные (URL и токен); без них прямой опрос источников с vm-core безопасно блокируется с ошибкой.

| Переменная | Функция | По умолчанию | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_FORAGING_FETCHER_URL` | FORAGING edge fetch | не задано | Базовый адрес шлюза выборки (например, на myr-vm1), через который читаются источники фуражировки. | Не задано или пусто — используется `MYRMIDON_VMEXEC_URL`. Если оба не заданы, безопасный отказ (fail-closed, 0 исходящих запросов с vm-core). |
| `MYRMIDON_FORAGING_FETCHER_TOKEN` | FORAGING edge fetch | не задано | Bearer-токен шлюза выборки, в паре с `MYRMIDON_FORAGING_FETCHER_URL`. В журналы не пишется. | Не задано или пусто — используется `MYRMIDON_VMEXEC_TOKEN`. |
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | не задано | Устаревший базовый адрес шлюза выборки. Рекомендуется `MYRMIDON_FORAGING_FETCHER_URL`. | Не задано или пусто — безопасный отказ, если не задан `MYRMIDON_FORAGING_FETCHER_URL`. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | не задано | Устаревший Bearer-токен шлюза выборки. В журналы не пишется. | Не задано или пусто — безопасный отказ, если не задан `MYRMIDON_FORAGING_FETCHER_TOKEN`. |
