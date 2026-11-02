## settings-en-new

<!-- after: 1.6.5 — SWARM: the board pairs tasks with free agents, no "look for work" wakes -->

### 1.6.6 — FORAGING: vm-exec edge fetch

The foraging reader (`server/src/myrmidon/foraging/reader.ts`) can read a source through the vm-exec fetch gateway instead of from the board host. Both variables are required; without them edge fetch is off.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_FORAGING_FETCHER_URL` | FORAGING edge fetch | unset | Base URL of the edge fetch gateway (e.g. on myr-vm1) that reads foraging sources from outside the board host. | Unset or empty — falls back to `MYRMIDON_VMEXEC_URL`. If neither is set, falls back to direct source HTTP fetch. |
| `MYRMIDON_FORAGING_FETCHER_TOKEN` | FORAGING edge fetch | unset | Bearer token for the edge fetch gateway, paired with `MYRMIDON_FORAGING_FETCHER_URL`. Never logged. | Unset or empty — falls back to `MYRMIDON_VMEXEC_TOKEN`. |
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | unset | Legacy base URL of the fetch gateway. Deprecated in favor of `MYRMIDON_FORAGING_FETCHER_URL`. | Unset or empty — edge fetch falls back to direct source HTTP fetch unless `MYRMIDON_FORAGING_FETCHER_URL` is set. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | unset | Legacy Bearer token for the fetch gateway. Never logged. | Unset or empty — edge fetch falls back to direct source HTTP fetch unless `MYRMIDON_FORAGING_FETCHER_TOKEN` is set. |

## settings-ru-new

<!-- after: 1.6.5 — SWARM: сопоставление на доске, без побудок «поищи работу» -->

### 1.6.6 — FORAGING: чтение источников через vm-exec

Читатель источников фуражировки (`server/src/myrmidon/foraging/reader.ts`) может читать источник через шлюз выборки на vm-exec, а не с хоста доски. Нужны обе переменные; без них чтение через vm-exec выключено.

| Переменная | Функция | По умолчанию | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_FORAGING_FETCHER_URL` | FORAGING edge fetch | не задано | Базовый адрес шлюза выборки (например, на myr-vm1), через который читаются источники фуражировки. | Не задано или пусто — используется `MYRMIDON_VMEXEC_URL`. Если оба не заданы, читает напрямую через HTTP(S). |
| `MYRMIDON_FORAGING_FETCHER_TOKEN` | FORAGING edge fetch | не задано | Bearer-токен шлюза выборки, в паре с `MYRMIDON_FORAGING_FETCHER_URL`. В журналы не пишется. | Не задано или пусто — используется `MYRMIDON_VMEXEC_TOKEN`. |
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | не задано | Устаревший базовый адрес шлюза выборки. Рекомендуется `MYRMIDON_FORAGING_FETCHER_URL`. | Не задано или пусто — читает напрямую через HTTP(S), если не задан `MYRMIDON_FORAGING_FETCHER_URL`. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | не задано | Устаревший Bearer-токен шлюза выборки. В журналы не пишется. | Не задано или пусто — читает напрямую через HTTP(S), если не задан `MYRMIDON_FORAGING_FETCHER_TOKEN`. |
