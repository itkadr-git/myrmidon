---
settings-section: Track 5 — operations
---

## changelog-en

### LITELLM-WORKERS-A: the LiteLLM worker-process count is stored, resized live and reported (1.6.5)

- The board stores a target number of LiteLLM gateway workers per company
  (instance settings key `myrmidonLitellmWorkersCompanies`, written under a row
  lock) and reports it with the CPU ceiling (`maxByCpu`) and the memory ceiling
  (`maxByMemory`, `floor(memoryGb / 1.5)`).
- `GET /api/myrmidon/companies/:companyId/litellm/workers` answers the current
  pool size, the target, the ceilings and the live metrics (per-worker CPU,
  median latency, queue depth); an absent number is reported as absent, not as
  zero. `perWorkerCpu` is a percentage (0..100), as the Costs page draws it.
  When no source knows the pool size (the declared baseline counts as one),
  `current` is `null` and `currentSource` is `unknown`; the Costs page shows
  "unknown".
- `PUT …/workers` with `{ "target": <integer> }` stores the target and moves the
  gunicorn pool to it with TTIN/TTOU signals, without a gateway restart. A
  target above the memory or CPU ceiling is a 400 with `details.reason`
  `above_memory` or `above_cpu`. When no source knows the pool size, the target
  is stored and the pool is left alone. Only an instance admin may PUT (the pool
  is one per instance), and whole resizes are serialised by a database advisory
  lock, so two concurrent PUTs signal only for the difference.

## changelog-ru

### LITELLM-WORKERS-A: число процессов LiteLLM хранится, меняется на ходу и отображается (1.6.5)

- Доска хранит целевое число воркеров шлюза LiteLLM на компанию (ключ настроек
  инстанса `myrmidonLitellmWorkersCompanies`, запись под блокировкой строки) и
  отдаёт его вместе с потолком по CPU (`maxByCpu`) и по памяти (`maxByMemory`,
  `floor(memoryGb / 1.5)`).
- `GET /api/myrmidon/companies/:companyId/litellm/workers` отвечает текущим
  размером пула, целью, потолками и живыми метриками (CPU по процессам, медиана
  ответа, глубина очереди); отсутствующее число так и помечается, а не
  выдаётся нулём. `perWorkerCpu` — проценты (0..100), как рисует страница
  «Затраты». Если размер пула не известен ни из одного источника (заявленный
  baseline считается источником), `current` — `null`, а `currentSource` —
  `unknown`; страница «Затраты» показывает «неизвестно».
- `PUT …/workers` с `{ "target": <целое> }` сохраняет цель и переводит пул
  gunicorn на неё сигналами TTIN/TTOU без рестарта шлюза. Цель выше потолка по
  памяти или CPU — 400 с `details.reason` `above_memory` / `above_cpu`. Если
  размер пула не известен ни из одного источника, цель сохраняется, а пул не
  трогается. PUT доступен только администратору инстанса (пул один на инстанс),
  а изменения целиком сериализуются advisory-блокировкой в БД: два параллельных
  PUT шлют сигналы только на разницу.

## settings-en

| `MYRMIDON_LITELLM_WORKERS_CORES` | LITELLM-WORKERS A | `6` | CPU cores of the gateway container; the CPU ceiling `maxByCpu` and the default target (cores minus one) derive from it | A positive integer |
| `MYRMIDON_LITELLM_WORKERS_MEMORY_GB` | LITELLM-WORKERS A | `12` | Memory of the gateway container in GB; the memory ceiling `maxByMemory` is `floor(memoryGb / 1.5)` | A positive number |
| `MYRMIDON_LITELLM_WORKERS_CONTAINER` | LITELLM-WORKERS A | `litellm-gateway` | Container that receives the TTIN/TTOU signals | A container name |
| `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` | LITELLM-WORKERS A | `docker kill -s {signal} {container}` | Command template the board runs once per resize step | A command with `{signal}` and `{container}` placeholders |
| `MYRMIDON_LITELLM_WORKERS_BASELINE` | LITELLM-WORKERS A | unset | Declared pool size used when the gateway reports none, so that the number of signals can be counted | A positive integer; unset — the pool is left alone when no source knows its size |

## settings-ru

| `MYRMIDON_LITELLM_WORKERS_CORES` | LITELLM-WORKERS A | `6` | Число ядер контейнера шлюза; от него считаются потолок `maxByCpu` и цель по умолчанию (ядра минус один) | Положительное целое |
| `MYRMIDON_LITELLM_WORKERS_MEMORY_GB` | LITELLM-WORKERS A | `12` | Память контейнера шлюза в ГБ; потолок по памяти `maxByMemory` — `floor(memoryGb / 1.5)` | Положительное число |
| `MYRMIDON_LITELLM_WORKERS_CONTAINER` | LITELLM-WORKERS A | `litellm-gateway` | Контейнер, которому шлются сигналы TTIN/TTOU | Имя контейнера |
| `MYRMIDON_LITELLM_WORKERS_SIGNAL_COMMAND` | LITELLM-WORKERS A | `docker kill -s {signal} {container}` | Шаблон команды, которую доска запускает на каждый шаг изменения | Команда с подстановками `{signal}` и `{container}` |
| `MYRMIDON_LITELLM_WORKERS_BASELINE` | LITELLM-WORKERS A | не задано | Заявленный размер пула на случай, когда шлюз его не отдаёт, чтобы можно было посчитать число сигналов | Положительное целое; не задано — пул не трогается, если размер не известен ни из одного источника |
