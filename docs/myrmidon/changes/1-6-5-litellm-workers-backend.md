## changelog-en

### LITELLM-WORKERS-A: the LiteLLM worker-process count is stored, resized live and reported (1.6.5)

- The board stores a target number of LiteLLM gateway workers per company
  (instance settings key `myrmidonLitellmWorkersCompanies`, written under a row
  lock) and reports it with the CPU ceiling (`maxByCpu`) and the memory ceiling
  (`maxByMemory`, `floor(memoryGb / 1.5)`).
- `GET /api/myrmidon/companies/:companyId/litellm/workers` answers the current
  pool size, the target, the ceilings and the live metrics (per-worker CPU,
  median latency, queue depth); an absent number is reported as absent, not as
  zero.
- `PUT …/workers` with `{ "target": <integer> }` stores the target and moves the
  gunicorn pool to it with TTIN/TTOU signals, without a gateway restart. A
  target above the memory or CPU ceiling is a 400 with `details.reason`
  `above_memory` or `above_cpu`. When no source knows the pool size, the target
  is stored and the pool is left alone.

## changelog-ru

### LITELLM-WORKERS-A: число процессов LiteLLM хранится, меняется на ходу и отображается (1.6.5)

- Доска хранит целевое число воркеров шлюза LiteLLM на компанию (ключ настроек
  инстанса `myrmidonLitellmWorkersCompanies`, запись под блокировкой строки) и
  отдаёт его вместе с потолком по CPU (`maxByCpu`) и по памяти (`maxByMemory`,
  `floor(memoryGb / 1.5)`).
- `GET /api/myrmidon/companies/:companyId/litellm/workers` отвечает текущим
  размером пула, целью, потолками и живыми метриками (CPU по процессам, медиана
  ответа, глубина очереди); отсутствующее число так и помечается, а не
  выдаётся нулём.
- `PUT …/workers` с `{ "target": <целое> }` сохраняет цель и переводит пул
  gunicorn на неё сигналами TTIN/TTOU без рестарта шлюза. Цель выше потолка по
  памяти или CPU — 400 с `details.reason` `above_memory` / `above_cpu`. Если
  размер пула не известен ни из одного источника, цель сохраняется, а пул не
  трогается.
