## settings-en-new

<!-- after: 1.6.5 — SWARM: the board pairs tasks with free agents, no "look for work" wakes -->

### 1.6.6 — FORAGING: vm-exec edge fetch

The foraging reader (`server/src/myrmidon/foraging/reader.ts`) can read a source through the vm-exec fetch gateway instead of from the board host. Both variables are required; without them edge fetch is off.

| Variable | Function | Default | What it does | How to disable / special |
|---|---|---|---|---|
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | unset | Base URL of the vm-exec fetch gateway that reads foraging sources from outside the board host. | Unset or empty — edge fetch is off: a source that needs it fails with `vm-exec edge fetch is not configured`; the board host never fetches it directly. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | unset | Bearer token for the vm-exec fetch gateway, paired with `MYRMIDON_VMEXEC_URL`. Never logged. | Unset or empty — edge fetch is off (both variables are required). |

## settings-ru-new

<!-- after: 1.6.5 — SWARM: сопоставление на доске, без побудок «поищи работу» -->

### 1.6.6 — FORAGING: чтение источников через vm-exec

Читатель источников фуражировки (`server/src/myrmidon/foraging/reader.ts`) может читать источник через шлюз выборки на vm-exec, а не с хоста доски. Нужны обе переменные; без них чтение через vm-exec выключено.

| Переменная | Функция | По умолчанию | Что делает | Как отключить / особенности |
|---|---|---|---|---|
| `MYRMIDON_VMEXEC_URL` | FORAGING edge fetch | не задано | Базовый адрес шлюза выборки на vm-exec, через который читаются источники фуражировки. | Не задано или пусто — чтение через vm-exec выключено: источник, которому оно нужно, падает с `vm-exec edge fetch is not configured`; хост доски его напрямую не читает. |
| `MYRMIDON_VMEXEC_TOKEN` | FORAGING edge fetch | не задано | Bearer-токен шлюза выборки vm-exec, в паре с `MYRMIDON_VMEXEC_URL`. В журналы не пишется. | Не задано или пусто — чтение через vm-exec выключено (нужны обе переменные). |
